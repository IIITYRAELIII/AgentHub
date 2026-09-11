import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { RecordingContourProvider } from "./recording-contour-provider.mjs";

const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? "" : process.argv[index + 1]; };
const root = argument("--recording-root");
const file = argument("--request-file");
if (!root || !path.isAbsolute(root) || !file || !path.isAbsolute(file)
  || process.env.AGENT_HUB_TEST_CONTOUR !== "1" || process.env.AGENT_HUB_RECORDING_PROVIDER_ROOT !== root
  || path.dirname(file) !== path.join(root, "requests")) throw new Error("Invalid isolated recording launch");
for (const candidate of [path.dirname(file), file]) if (lstatSync(candidate).isSymbolicLink()) throw new Error("Recording request cannot use a link");
const bytes = readFileSync(file);
if (`${createHash("sha256").update(bytes).digest("hex")}.json` !== path.basename(file)) throw new Error("Recording request hash mismatch");
const request = JSON.parse(bytes.toString("utf8"));
const provider = new RecordingContourProvider({ root, provider: "claude" });
const send = (event) => process.stdout.write(`${JSON.stringify({ session_id: request.threadId, ...event })}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let accepted = false;
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (!accepted) {
      if (message.type !== "user" || message.message?.content !== request.expectedStdin) throw new Error("Recording input differs from exact launch binding");
      const result = provider.start(request);
      accepted = true;
      send({ type: "system", subtype: "init", model: "literal-recording", tools: [] });
      // An already completed command replays only its recorded result.
      if (result.turn.status !== "inProgress") return finish(result.turn);
      return;
    }
    if (message.type !== "contour-finish" || message.clientUserMessageId !== request.clientUserMessageId) throw new Error("Recording steer requires a new exact command binding; unsupported here");
    finish(provider.finish({ threadId: request.threadId, turnId: request.turnId, status: message.status, answer: message.answer }));
  } catch (error) { send({ type: "result", subtype: "error_during_execution", is_error: true, result: error.message }); lines.close(); }
});
function finish(turn) {
  send({ type: "result", subtype: turn.status === "completed" ? "success" : "error_during_execution", is_error: turn.status !== "completed", result: turn.items.at(-1).text, usage: {} });
  lines.close();
}
lines.once("close", () => { provider.close(); process.stdin.destroy(); });
