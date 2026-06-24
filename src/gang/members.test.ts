import test from "node:test";
import assert from "node:assert/strict";
import { buildMemberEnv, isValidRole, Roster, ORCHESTRATOR } from "./members.ts";

test("buildMemberEnv sets the 5 PI_SUBAGENT_* vars intercom reads", () => {
  const env = buildMemberEnv({ role: "worker", runId: "run-1", index: 2 });
  assert.deepEqual(env, {
    PI_SUBAGENT_INTERCOM_SESSION_NAME: "worker",
    PI_SUBAGENT_ORCHESTRATOR_TARGET: "boss",
    PI_SUBAGENT_RUN_ID: "run-1",
    PI_SUBAGENT_CHILD_AGENT: "worker",
    PI_SUBAGENT_CHILD_INDEX: "2",
  });
  assert.equal(ORCHESTRATOR, "boss");
});

test("isValidRole accepts safe tokens, rejects shell/tmux-hostile ones", () => {
  for (const ok of ["worker", "reviewer", "agent-1", "Build_2"]) assert.ok(isValidRole(ok), ok);
  for (const bad of ["", "1abc", "a b", "a;b", "a/b", "$x", "a".repeat(40)]) assert.ok(!isValidRole(bad), bad);
});

test("Roster hands out monotonic indexes and a stable runId", () => {
  const r = new Roster();
  assert.equal(r.nextIndex(), 0);
  assert.equal(r.nextIndex(), 1);
  const runId = r.runId;
  r.add({ role: "worker", task: "t", index: 0, paneId: "%1", runId, spawnedAt: 1 });
  assert.equal(r.list().length, 1);
  assert.equal(r.list()[0].role, "worker");
  assert.equal(r.runId, runId, "runId is stable for the boss process");
});
