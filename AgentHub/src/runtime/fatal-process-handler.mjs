export function createFatalProcessHandler({
  shutdown,
  captureException = null,
  flushDiagnostics = null,
  logger = console,
  processRef = process,
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
    }
  };
}
