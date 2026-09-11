import { createInterface } from "node:readline";
import path from "node:path";
import { RecordingContourProvider } from "./recording-contour-provider.mjs";

const rootIndex = process.argv.indexOf("--recording-root");
const root = rootIndex < 0 ? "" : process.argv[rootIndex + 1];
if (!root || !path.isAbsolute(root) || process.env.AGENT_HUB_TEST_CONTOUR !== "1"
  || path.resolve(process.env.AGENT_HUB_RECORDING_PROVIDER_ROOT || ".") !== path.resolve(root)) {
  throw new Error("Literal recording CLI requires its explicit isolated environment and root");
}
const provider = new RecordingContourProvider({ root, provider: "codex" });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params });

function request(method, params) {
  switch (method) {
    case "initialize": return { userAgent: "agent-hub-literal-recording-contour" };
    case "account/read": return { account: null, requiresOpenaiAuth: false };
    case "account/rateLimits/read": return { rateLimits: null };
    case "model/list": return { data: [], nextCursor: null };
    case "thread/list": return { data: provider.threads(), nextCursor: null };
    case "thread/loaded/list": return { data: provider.threads().map((thread) => thread.id), nextCursor: null };
    case "thread/read":
    case "thread/resume": return { thread: provider.thread(params.threadId) };
    case "thread/turns/list": return { data: provider.thread(params.threadId).turns, nextCursor: null };
    case "turn/start": {
      const result = provider.start(params);
      return { result: { turn: result.turn }, afterReply: result.duplicate ? null : () => notify("turn/started", { threadId: params.threadId, turn: result.turn }) };
    }
    case "turn/interrupt": {
      const turn = provider.finish({ threadId: params.threadId, turnId: params.turnId, status: "interrupted", answer: "Recording scenario interrupted" });
      return { result: {}, afterReply: () => notify("turn/completed", { threadId: params.threadId, turn }) };
    }
    // Scenario control is a distinct method. No phrase or marker in a prompt
    // reaches this branch. It is intentionally local to this isolated CLI.
    case "contour/finish": {
      const turn = provider.finish(params);
      return { result: { turn }, afterReply: () => {
        notify("item/completed", { threadId: params.threadId, turnId: turn.id, item: turn.items.at(-1) });
        notify("turn/completed", { threadId: params.threadId, turn });
      } };
    }
    default: throw new Error(`Unsupported recording operation: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined && message.method === "initialized") return;
    if (message.id === undefined) throw new Error("Unsupported recording notification");
    const result = request(message.method, message.params ?? {});
    send({ id: message.id, result: result?.afterReply !== undefined ? result.result : result });
    result?.afterReply?.();
  } catch (error) {
    send({ id: message?.id ?? null, error: { code: -32602, message: error.message } });
  }
});
lines.once("close", () => provider.close());
