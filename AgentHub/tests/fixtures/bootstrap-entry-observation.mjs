import process from "node:process";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";

const entry = new URL("../../agent-hub-main.mjs", import.meta.url);
const server = new URL("../../agent-hub-server.mjs", import.meta.url).href;
const events = [], fatalOptions = [];
const startupError = new Error("controlled startup failure");
const processPort = new EventEmitter();
async function shutdown(reason) { events.push(["shutdown", reason]); }
globalThis.bootstrapObservation = { processPort, server: {
  async startAgentHub() {
    events.push(["start"]);
    if (process.argv[2] === "failure") throw startupError;
  },
  shutdownAgentHub: shutdown,
  createFatalProcessHandler(options) {
    fatalOptions.push({ sameShutdown: options.shutdown === shutdown,
      exitAfterShutdown: options.exitAfterShutdown === true });
    return async (reason, error) => {
      events.push(["fatal", reason, error === startupError ? "startup" : error.message,
        options.exitAfterShutdown === true]);
      await options.shutdown(reason);
    };
  },
} };
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === entry.href && specifier === "node:process") {
    return { url: "data:text/javascript,export default globalThis.bootstrapObservation.processPort", shortCircuit: true };
  }
  const resolved = nextResolve(specifier, context);
  if (resolved.url === server) return {
    url: "data:text/javascript,export const {startAgentHub,shutdownAgentHub,createFatalProcessHandler}=globalThis.bootstrapObservation.server",
    shortCircuit: true,
  };
  return resolved;
} });
await import(entry.href);
processPort.emit("SIGINT");
processPort.emit("SIGTERM");
processPort.emit("unhandledRejection", new Error("rejection"));
processPort.emit("uncaughtException", new Error("exception"));
await new Promise(resolve => setImmediate(resolve));
process.stdout.write(JSON.stringify({ events, fatalOptions }));
