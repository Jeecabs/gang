import test from "node:test";
import assert from "node:assert/strict";
import { getGangArgumentCompletions, parseSpawnCommand } from "./index.ts";

test("gang command completes subcommands", () => {
  assert.deepEqual(getGangArgumentCompletions("wa"), [
    { value: "watch", label: "watch", description: "Open mission control" },
  ]);
  assert.deepEqual(getGangArgumentCompletions("sp"), [
    { value: "spawn ", label: "spawn", description: "Spawn a member: spawn <role> <task>" },
  ]);
});

test("gang command completes spawn roles", () => {
  assert.deepEqual(getGangArgumentCompletions("spawn rev"), [
    { value: "spawn reviewer ", label: "reviewer", description: "Spawn reviewer member" },
  ]);
  assert.equal(getGangArgumentCompletions("spawn reviewer check the diff"), null);
});

test("gang command completes thinking flags and levels", () => {
  assert.deepEqual(getGangArgumentCompletions("spawn reviewer --"), [
    { value: "spawn reviewer --thinking ", label: "--thinking", description: "Set member thinking level" },
  ]);
  assert.deepEqual(getGangArgumentCompletions("spawn reviewer --thinking h"), [
    { value: "spawn reviewer --thinking high ", label: "high", description: "Use high thinking" },
  ]);
});

test("parseSpawnCommand accepts thinking before or after role", () => {
  assert.deepEqual(parseSpawnCommand("--thinking high reviewer check the diff"), {
    ok: true,
    role: "reviewer",
    task: "check the diff",
    thinkingLevel: "high",
  });
  assert.deepEqual(parseSpawnCommand("reviewer -t low check the diff"), {
    ok: true,
    role: "reviewer",
    task: "check the diff",
    thinkingLevel: "low",
  });
});

test("parseSpawnCommand rejects invalid thinking", () => {
  const result = parseSpawnCommand("reviewer --thinking huge check the diff");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Invalid thinking level/);
});
