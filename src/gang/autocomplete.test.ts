import test from "node:test";
import assert from "node:assert/strict";
import { getGangArgumentCompletions } from "./index.ts";

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
