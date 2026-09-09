export function parseCommandTraceReportArgs(args, nowMs = Date.now()) {
  const [databaseFile, ...options] = args;
  if (!databaseFile || databaseFile.startsWith("--")) {
    throw new Error("Usage: npm run trace:report -- <command-traces.sqlite> [--hours 24] [--limit 25]");
  }
  let hours = 24;
  let limit = 25;
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = Number(options[index + 1]);
    if (!["--hours", "--limit"].includes(flag) || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid report option: ${flag}`);
    }
    if (flag === "--hours") hours = Math.min(24 * 7, value);
    if (flag === "--limit") {
      if (!Number.isSafeInteger(value)) throw new Error("--limit must be an integer");
      limit = Math.min(100, value);
    }
  }
  return { databaseFile, options: {
    fromMs: Math.max(0, nowMs - Math.round(hours * 60 * 60 * 1_000)), toMs: nowMs, limit,
  } };
}

export function runCommandTraceReport(args, { readReport, write = console.log, nowMs = Date.now() }) {
  const { databaseFile, options } = parseCommandTraceReportArgs(args, nowMs);
  const report = readReport(databaseFile, options);
  write(JSON.stringify(report, null, 2));
  return report;
}
