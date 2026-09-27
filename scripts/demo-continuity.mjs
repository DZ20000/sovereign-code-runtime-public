#!/usr/bin/env node
import { runContinuityDemo } from "./demo-continuity-lib.mjs";

const supported = new Set(["--json", "--keep"]);
const unknown = process.argv.slice(2).filter((argument) => !supported.has(argument));
if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(", ")}`);
  process.exitCode = 2;
} else {
  try {
    const report = await runContinuityDemo({ keep: process.argv.includes("--keep") });
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("Sovereign continuity demo");
      console.log("[pass] Session A created a durable local Task and checkpoint.");
      console.log("[pass] The Task and messages survived a registry restart.");
      console.log("[pass] Closing Session A preserved workflow state but removed its live lease.");
      console.log("[pass] Session B resumed the same Task from local state.");
      console.log(`[pass] Session A was rejected after closure (${report.closedSessionErrorCode}).`);
      console.log("\nResult: durable work survived; stale session authority did not.");
      if (report.retainedDirectory !== null) {
        console.log(`Demo state retained at: ${report.retainedDirectory}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
