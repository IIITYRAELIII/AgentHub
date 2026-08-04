import process from "node:process";
import { shutdownAgentHub, startAgentHub } from "./agent-hub-server.mjs";

process.on("unhandledRejection", (error) => {
  console.error("Unhandled asynchronous error:", error);
});

process.on("SIGINT", () => void shutdownAgentHub("SIGINT"));
process.on("SIGTERM", () => void shutdownAgentHub("SIGTERM"));

try {
  await startAgentHub();
} catch (error) {
  console.error("Agent Hub startup failed:", error);
  await shutdownAgentHub("startup-error").catch((shutdownError) => {
    console.error("Agent Hub startup cleanup failed:", shutdownError);
  });
  process.exitCode = 1;
}
