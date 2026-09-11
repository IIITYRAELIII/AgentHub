import { readCommandTraceReport } from "../infrastructure/persistence/command-trace-report-reader.mjs";
import { runCommandTraceReport } from "../interfaces/cli/command-trace-report.mjs";

try {
  runCommandTraceReport(process.argv.slice(2), { readReport: readCommandTraceReport });
} catch (error) {
  console.error(`Cannot read command trace report: ${error?.message ?? error}`);
  process.exitCode = 1;
}
