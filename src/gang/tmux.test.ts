import test from "node:test";
import assert from "node:assert/strict";
import { envFlags, splitArgs, newSessionArgs, tiledLayoutArgs, remainOnExitArgs, memberCommand, listPanesArgs, listAllPanesArgs, killPaneArgs, killSessionArgs, parsePaneList } from "./tmux.ts";

test("envFlags emits one -e KEY=VAL pair per var", () => {
  assert.deepEqual(envFlags({ A: "1", B: "2" }), ["-e", "A=1", "-e", "B=2"]);
});

test("splitArgs prints the new pane id and sets cwd + env", () => {
  const args = splitArgs({ target: "gang", cwd: "/repo", env: { PI_SUBAGENT_RUN_ID: "r1" }, command: "pi --name worker @/t.md" });
  assert.deepEqual(args, [
    "split-window", "-t", "gang", "-P", "-F", "#{pane_id}",
    "-c", "/repo", "-e", "PI_SUBAGENT_RUN_ID=r1", "pi --name worker @/t.md",
  ]);
});

test("session + layout + remain-on-exit builders target the gang session/pane", () => {
  assert.deepEqual(newSessionArgs(), ["new-session", "-d", "-s", "gang", "-x", "220", "-y", "50"]);
  assert.deepEqual(tiledLayoutArgs("gang"), ["select-layout", "-t", "gang", "tiled"]);
  assert.deepEqual(tiledLayoutArgs(), ["select-layout", "-t", "gang", "tiled"]); // default = gang session, never the live window
  assert.deepEqual(remainOnExitArgs("%3"), ["set-option", "-p", "-t", "%3", "remain-on-exit", "on"]);
});

test("in-tmux builders target pi's own pane so members land in pi's window", () => {
  // -t <pane> splits pi's pane (not whatever window is active); -d keeps focus on the caller's (pi) pane.
  assert.deepEqual(splitArgs({ target: "%0", cwd: "/repo", env: { A: "1" }, command: "pi", detached: true }), [
    "split-window", "-t", "%0", "-d", "-P", "-F", "#{pane_id}", "-c", "/repo", "-e", "A=1", "pi",
  ]);
  assert.deepEqual(tiledLayoutArgs("%0"), ["select-layout", "-t", "%0", "tiled"]);
  assert.deepEqual(listAllPanesArgs(), ["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"]);
});

test("memberCommand loads exactly intercom+gang and passes the task as a quoted @file", () => {
  const cmd = memberCommand({ role: "worker", taskFile: "/a b/t.md", intercomIndex: "/x/intercom/index.ts", gangIndex: "/x/gang/index.ts" });
  assert.equal(cmd, "pi --name worker --no-extensions -e '/x/intercom/index.ts' -e '/x/gang/index.ts' @'/a b/t.md'");
  // task path with a space must stay a single shell token
  assert.ok(cmd.includes("@'/a b/t.md'"));
});

test("memberCommand passes an optional thinking level", () => {
  const cmd = memberCommand({ role: "worker", taskFile: "/t.md", intercomIndex: "/x/intercom/index.ts", gangIndex: "/x/gang/index.ts", thinkingLevel: "high" });
  assert.equal(cmd, "pi --name worker --thinking high --no-extensions -e '/x/intercom/index.ts' -e '/x/gang/index.ts' @'/t.md'");
});

test("cleanup builders target the gang session/pane", () => {
  assert.deepEqual(listPanesArgs(), ["list-panes", "-t", "gang", "-F", "#{pane_id} #{pane_dead}"]);
  assert.deepEqual(killPaneArgs("%4"), ["kill-pane", "-t", "%4"]);
  assert.deepEqual(killSessionArgs(), ["kill-session", "-t", "gang"]);
});

test("parsePaneList reads pane id + dead flag, ignoring blank lines", () => {
  assert.deepEqual(parsePaneList("%1 0\n%2 1\n\n  %3 0  \n"), [
    { paneId: "%1", dead: false },
    { paneId: "%2", dead: true },
    { paneId: "%3", dead: false },
  ]);
  assert.deepEqual(parsePaneList(""), []);
});
