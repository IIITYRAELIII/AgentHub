import { sentryDiagnostics } from "../infrastructure/diagnostics/sentry-diagnostics.mjs";

export function createFatalProcessHandler({
  shutdown,
  captureException = (error, context) => sentryDiagnostics.captureException(error, context),
  flushDiagnostics = (timeoutMs) => sentryDiagnostics.flush(timeoutMs),
  logger = console,
  processRef = process,
  exitAfterShutdown = false,
} = {}) {
  if (typeof shutdown !== "function") throw new TypeError("shutdown must be a function");
  let handling = false;

  return async function handleFatalProcessError(kind, error) {
    if (handling) return;
    handling = true;
    processRef.exitCode = 1;
    logger.error(`Agent Hub ${kind}:`, error);
    try {
      captureException?.(error, { surface: "server", kind: "fatal", component: "process" });
      await flushDiagnostics?.(2_000);
    } catch (diagnosticsError) {
      logger.error("Agent Hub fatal diagnostics failed:", diagnosticsError);
    }
    try {
      await shutdown(kind);
    } catch (shutdownError) {
      logger.error("Agent Hub fatal shutdown failed:", shutdownError);
      processRef.exit?.(1);
      return;
    }
    // A failed startup may keep the instance pipe, SQLite or timers open. Without
    // an explicit exit that half-started process would hold its lock forever.
    if (exitAfterShutdown) processRef.exit?.(1);
  };
}
