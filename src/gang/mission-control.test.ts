import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { renderMissionControl, MissionControlOverlay } from "./ui/mission-control.ts";

// Mirror the real pi ThemeColor union so an invalid color name (e.g. "pink") fails the test
// instead of silently passing — that bug crashed the real TUI on render.
const THEME_COLORS = new Set([
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted",
  "dim", "text", "thinkingText", "userMessageText", "customMessageText", "customMessageLabel",
  "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
]);
const theme = {
  fg: (c: string, t: string) => {
    assert.ok(THEME_COLORS.has(c), `invalid ThemeColor "${c}"`);
    return t;
  },
  bold: (t: string) => t,
};
const member = (name: string, status: string) => ({ id: name, name, cwd: "/r", model: "gpt-5.5", status, pid: 1, startedAt: 0, lastActivity: 0 });

test("renders members with status and a newest-first feed", () => {
  const out = renderMissionControl({
    members: [member("boss", "idle"), member("worker", "tool:bash")],
    feed: [{ ts: 0, from: "worker", to: "boss", text: "done", expectsReply: true }],
    online: true,
  }, theme, 80).join("\n");

  assert.match(out, /mission control/);
  assert.match(out, /MEMBERS · 2/);
  assert.match(out, /boss/);
  assert.match(out, /tool:bash/);
  assert.match(out, /worker → boss/);
  assert.match(out, /done/);
  assert.match(out, /● live/);
});

test("shows empty + offline states", () => {
  const out = renderMissionControl({ members: [], feed: [], online: false }, theme, 80).join("\n");
  assert.match(out, /no members yet/);
  assert.match(out, /waiting for messages/);
  assert.match(out, /○ offline/);
});

test("overlay folds SSE events into render state", () => {
  const feed = new EventEmitter();
  let renders = 0;
  const tui = { requestRender: () => { renders++; } };
  const overlay = new MissionControlOverlay(tui as never, theme as never, { matches: () => false } as never, feed as never, () => {});

  feed.emit("status", "up");
  feed.emit("event", { type: "snapshot", sessions: [member("boss", "idle")] });
  feed.emit("event", { type: "session_joined", session: member("worker", "thinking") });
  feed.emit("event", { type: "message", ts: 0, from: "worker", to: "boss", text: "found it" });
  feed.emit("event", { type: "session_left", sessionId: "worker" });

  const out = overlay.render(90).join("\n");
  assert.match(out, /boss/);
  assert.ok(!/thinking/.test(out), "worker left → no longer listed");
  assert.match(out, /worker → boss/, "feed entry persists after sender leaves");
  assert.match(out, /found it/);
  assert.ok(renders >= 5, "each event requests a render");
});

test("snapshot seeds members + recent feed history, newest-first", () => {
  const feed = new EventEmitter();
  const overlay = new MissionControlOverlay({ requestRender() {} } as never, theme as never, { matches: () => false } as never, feed as never, () => {});
  feed.emit("event", {
    type: "snapshot",
    sessions: [member("boss", "idle")],
    feed: [
      { type: "message", ts: 1, from: "worker", to: "boss", text: "OLDER" },
      { type: "message", ts: 2, from: "boss", to: "reviewer", text: "NEWER" },
    ],
  });
  const lines = overlay.render(90);
  const idxNewer = lines.findIndex((l) => l.includes("NEWER"));
  const idxOlder = lines.findIndex((l) => l.includes("OLDER"));
  assert.ok(idxNewer !== -1 && idxOlder !== -1, "both history items rendered");
  assert.ok(idxNewer < idxOlder, "newest history item renders above older");
});
