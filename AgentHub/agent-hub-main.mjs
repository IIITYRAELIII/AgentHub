import process from "node:process";
import {
  createFatalProcessHandler,
  shutdownAgentHub,
  startAgentHub,
} from "./agent-hub-server.mjs";

const handleFatalProcessError = createFatalProcessHandler({ shutdown: shutdownAgentHub });
const handleFatalStartupError = createFatalProcessHandler({
  shutdown: shutdownAgentHub,
  exitAfterShutdown: true,
});

process.on("SIGINT", () => void shutdownAgentHub("SIGINT"));
process.on("SIGTERM", () => void shutdownAgentHub("SIGTERM"));
process.on("unhandledRejection", (error) => void handleFatalProcessError("unhandled rejection", error));
process.on("uncaughtException", (error) => void handleFatalProcessError("uncaught exception", error));

try {
  await startAgentHub();
} catch (error) {
  await handleFatalStartupError("startup failed", error);
}
