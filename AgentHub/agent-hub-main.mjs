import process from "node:process";
import {
  createFatalProcessHandler,
  shutdownAgentHub,
  startAgentHub,
} from "./agent-hub-server.mjs";
import { sentryDiagnostics } from "./src/infrastructure/diagnostics/sentry-diagnostics.mjs";

const handleFatalProcessError = createFatalProcessHandler({
  shutdown: shutdownAgentHub,
  captureException: (error, context) => sentryDiagnostics.captureException(error, context),
  flushDiagnostics: (timeoutMs) => sentryDiagnostics.flush(timeoutMs),
});

process.on("SIGINT", () => void shutdownAgentHub("SIGINT"));
process.on("SIGTERM", () => void shutdownAgentHub("SIGTERM"));
process.on("unhandledRejection", (error) => void handleFatalProcessError("unhandled rejection", error));
process.on("uncaughtException", (error) => void handleFatalProcessError("uncaught exception", error));

try {
  await startAgentHub();
} catch (error) {
  console.error("Agent Hub startup failed:", error);
  sentryDiagnostics.captureException(error, { surface: "server", kind: "startup", component: "bootstrap" });
  await sentryDiagnostics.flush(2_000);
  await shutdownAgentHub("startup-error").catch((shutdownError) => {
    console.error("Agent Hub startup cleanup failed:", shutdownError);
  });
  process.exitCode = 1;
}
