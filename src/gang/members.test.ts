import test from "node:test";
import assert from "node:assert/strict";
import { buildMemberEnv, computeMemberRuntimeSnapshot, isValidRole, Roster, ORCHESTRATOR } from "./members.ts";

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

test("Roster.prune keeps only members whose pane is still alive", () => {
  const r = new Roster();
  r.add({ role: "a", task: "t", index: 0, paneId: "%1", runId: r.runId, spawnedAt: 1 });
  r.add({ role: "b", task: "t", index: 1, paneId: "%2", runId: r.runId, spawnedAt: 1 });
  r.add({ role: "c", task: "t", index: 2, paneId: "%3", runId: r.runId, spawnedAt: 1 });
  const removed = r.prune(new Set(["%2"]));   // %1 and %3 are gone/dead
  assert.equal(removed, 2);
  assert.deepEqual(r.list().map((m) => m.role), ["b"]);
});

test("Roster marks done reports and can remove by role", () => {
  const r = new Roster();
  r.add({ role: "a", task: "t", index: 0, paneId: "%1", runId: r.runId, spawnedAt: 1 });
  assert.equal(r.hasRole("a"), true);
  assert.equal(r.markReportedDone("a", 42, "done"), true);
  assert.equal(r.findByRole("a")?.reportedDoneAt, 42);
  assert.equal(r.findByRole("a")?.lastReportText, "done");
  assert.equal(r.removeByRoles(new Set(["a"])), 1);
  assert.equal(r.list().length, 0);
});

test("computeMemberRuntimeSnapshot classifies running, reported, dead, and missing panes", () => {
  const member = { role: "a", task: "t", index: 0, paneId: "%1", runId: "run", spawnedAt: 1 };
  assert.deepEqual(computeMemberRuntimeSnapshot(member, { paneId: "%1", dead: false, currentCommand: "pi", pid: 100 }), {
    member,
    paneExists: true,
    paneDead: false,
    processAlive: true,
    currentCommand: "pi",
    reportedDone: false,
    state: "running",
    reapable: false,
  });
  const reported = { ...member, reportedDoneAt: 9 };
  assert.equal(computeMemberRuntimeSnapshot(reported, { paneId: "%1", dead: false, currentCommand: "pi", pid: 100 }).state, "reported_done");
  assert.equal(computeMemberRuntimeSnapshot(member, { paneId: "%1", dead: true, currentCommand: "pi", pid: 100 }).state, "pane_dead");
  assert.equal(computeMemberRuntimeSnapshot(member).state, "pane_missing");
});

test("Roster.clear empties the roster", () => {
  const r = new Roster();
  r.add({ role: "a", task: "t", index: 0, paneId: "%1", runId: r.runId, spawnedAt: 1 });
  r.clear();
  assert.equal(r.list().length, 0);
});
