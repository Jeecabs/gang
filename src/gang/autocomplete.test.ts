import test from "node:test";
import assert from "node:assert/strict";
import { getGangArgumentCompletions, isDeadlineSeconds, parseSpawnCommand } from "./index.ts";

test("gang command completes subcommands", () => {
  assert.deepEqual(getGangArgumentCompletions("wa"), [
    { value: "watch", label: "watch", description: "Open mission control" },
  ]);
  assert.deepEqual(getGangArgumentCompletions("sp"), [
    { value: "spawn ", label: "spawn", description: "Spawn a member: spawn [@name] [-t <level>] <task>" },
  ]);
  assert.deepEqual(getGangArgumentCompletions("sto"), [
    { value: "stop ", label: "stop", description: "Stop one member or stop --all-finished" },
  ]);
});

test("gang spawn task text is free-form (no completion)", () => {
  assert.equal(getGangArgumentCompletions("spawn fix the failing"), null);
  assert.equal(getGangArgumentCompletions("spawn @rev review the diff"), null);
});

test("gang command completes the leading thinking flag and its levels", () => {
  assert.deepEqual(getGangArgumentCompletions("spawn --"), [
    { value: "spawn --thinking ", label: "--thinking", description: "Set member thinking level" },
  ]);
  assert.deepEqual(getGangArgumentCompletions("spawn @rev -"), [
    { value: "spawn @rev --thinking ", label: "--thinking", description: "Set member thinking level" },
  ]);
  assert.deepEqual(getGangArgumentCompletions("spawn --thinking h"), [
    { value: "spawn --thinking high ", label: "high", description: "Use high thinking" },
  ]);
});

test("parseSpawnCommand: task only, name auto-assigned (undefined)", () => {
  const r = parseSpawnCommand("fix the failing test");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.task, "fix the failing test");
    assert.equal(r.name, undefined);
    assert.equal(r.thinkingLevel, undefined);
  }
});

test("parseSpawnCommand: @name and thinking in any leading order", () => {
  const a = parseSpawnCommand("@rev -t low review the diff");
  assert.equal(a.ok, true);
  if (a.ok) {
    assert.equal(a.name, "rev");
    assert.equal(a.thinkingLevel, "low");
    assert.equal(a.task, "review the diff");
  }
  const b = parseSpawnCommand("--thinking high @rev review the diff");
  assert.equal(b.ok, true);
  if (b.ok) {
    assert.equal(b.name, "rev");
    assert.equal(b.thinkingLevel, "high");
    assert.equal(b.task, "review the diff");
  }
});

test("parseSpawnCommand: a non-leading @ stays inside the task", () => {
  const r = parseSpawnCommand("ping @alice about the bug");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.name, undefined);
    assert.equal(r.task, "ping @alice about the bug");
  }
});

test("gang tool deadline accepts bounded integer seconds", () => {
  for (const value of [1, 600, 86_400]) assert.equal(isDeadlineSeconds(value), true);
  for (const value of [0, 1.5, 86_401, "600", undefined]) assert.equal(isDeadlineSeconds(value), false);
});

test("parseSpawnCommand rejects invalid thinking", () => {
  const r = parseSpawnCommand("--thinking huge check the diff");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Invalid thinking level/);
});

test("parseSpawnCommand rejects an invalid @name", () => {
  const r = parseSpawnCommand("@1bad do the thing");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Invalid name/);
});

test("parseSpawnCommand requires a task", () => {
  const r = parseSpawnCommand("@rev");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Usage/);
});
