import assert from "node:assert/strict";
import test from "node:test";

import { runContinuityDemo } from "./demo-continuity-lib.mjs";

test("continuity demo exercises persistence, replacement, and stale-session rejection", async () => {
  const report = await runContinuityDemo();
  assert.deepEqual(report.checks, {
    taskPersistedAcrossRestart: true,
    workflowStateSurvivedDisconnect: true,
    replacementSessionResumed: true,
    closedSessionRejected: true,
  });
  assert.equal(report.finalTask.status, "running");
  assert.equal(report.finalTask.agentPresence, "online");
  assert.equal(report.closedSessionErrorCode, "POLICY_DENIED");
  assert.equal(report.retainedDirectory, null);
});
