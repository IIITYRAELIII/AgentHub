import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

// Заглушка Claude Code для E2E. Поддерживает маркеры в промпте:
//   [hold:NAME] — держать ход, пока в FAKE_CLAUDE_HOLD_DIR не появится файл NAME;
//   [child:NAME] — запустить дочерний процесс и записать его PID в NAME.pid;
//   [fail]      — завершиться ошибкой.
// Дополнительно пишет транскрипт сессии в FAKE_CLAUDE_TRANSCRIPT_ROOT, чтобы бот
// видел ход так же, как видит внешний запуск Claude.

const args = process.argv.slice(2);
const resumeIndex = args.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : randomUUID();
const promptIndex = args.length - 1;
let addDirectoryConsumesPrompt = false;
let readingAdditionalDirectories = false;
for (let index = 0; index <= promptIndex; index += 1) {
  const value = String(args[index] ?? "");
  if (value === "--add-dir") {
    readingAdditionalDirectories = true;
    continue;
  }
  if (readingAdditionalDirectories && value.startsWith("-")) {
    readingAdditionalDirectories = false;
  }
  if (index === promptIndex) addDirectoryConsumesPrompt = readingAdditionalDirectories;
}
const prompt = addDirectoryConsumesPrompt ? "" : args.at(-1) ?? "";
const holdDirectory = process.env.FAKE_CLAUDE_HOLD_DIR ?? "";
const transcriptRoot = process.env.FAKE_CLAUDE_TRANSCRIPT_ROOT ?? "";
const holdMatch = /\[hold:([^\]]+)\]/.exec(prompt);
const childMatch = /\[child:([^\]]+)\]/.exec(prompt);
const shouldFail = prompt.includes("[fail]");
const cwd = process.cwd();

if (prompt === "/usage") {
  sleep(Number(process.env.FAKE_CLAUDE_USAGE_DELAY_MS ?? 0));
  process.stdout.write("Current session\n5h 80% · resets in 2h\n");
  process.exit(0);
}

if (!prompt && resumeIndex >= 0) {
  const message = "No deferred tool marker found in the resumed session. Provide a prompt to continue the conversation.";
  process.stderr.write(message);
  emit({
    type: "result",
    subtype: "error_during_execution",
    session_id: sessionId,
    result: message,
    is_error: true,
    usage: {},
  });
  process.exit(1);
}

if (childMatch && holdDirectory) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  writeFileSync(path.join(holdDirectory, `${childMatch[1]}.pid`), String(child.pid), "utf8");
}

function encodedProjectDirectory(projectPath) {
  return String(projectPath).replace(/[\\/:]+/g, "-");
}

const transcriptPath = transcriptRoot
  ? path.join(transcriptRoot, encodedProjectDirectory(cwd), `${sessionId}.jsonl`)
  : "";

function findSessionTranscript(directory, fileName) {
  if (!directory || !existsSync(directory)) return "";
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName) return candidate;
    if (entry.isDirectory()) {
      const nested = findSessionTranscript(candidate, fileName);
      if (nested) return nested;
    }
  }
  return "";
}

function samePath(left, right) {
  const a = path.resolve(String(left ?? ""));
  const b = path.resolve(String(right ?? ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function writeTranscript(entries) {
  if (!transcriptPath) return;
  mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const text = entries.map((entry) => `${JSON.stringify({
    sessionId,
    cwd,
    timestamp: new Date().toISOString(),
    ...entry,
  })}\n`).join("");
  if (existsSync(transcriptPath)) appendFileSync(transcriptPath, text, "utf8");
  else writeFileSync(transcriptPath, text, "utf8");
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (resumeIndex >= 0 && transcriptRoot) {
  const existingTranscript = findSessionTranscript(transcriptRoot, `${sessionId}.jsonl`);
  if (existingTranscript) {
    const firstEntry = readFileSync(existingTranscript, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.cwd);
    if (firstEntry?.cwd && !samePath(firstEntry.cwd, cwd)) {
      process.stderr.write(
        `No conversation found with session ID ${sessionId} in working directory ${cwd}`,
      );
      emit({
        type: "result",
        subtype: "error_during_execution",
        session_id: sessionId,
        result: "",
        is_error: true,
        usage: {},
      });
      process.exit(1);
    }
  }
}

writeTranscript([
  { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } },
  { type: "ai-title", aiTitle: prompt.slice(0, 60) },
]);

emit({
  type: "stream_event",
  session_id: sessionId,
  event: {
    type: "content_block_delta",
    delta: { type: "text_delta", text: `Claude выполняет: ${prompt}` },
  },
});

if (holdMatch && holdDirectory) {
  const releaseFile = path.join(holdDirectory, holdMatch[1]);
  const deadline = Date.now() + 60_000;
  while (!existsSync(releaseFile) && Date.now() < deadline) sleep(100);
}

writeTranscript([
  {
    type: "assistant",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: `Claude готово: ${prompt}` }],
    },
  },
  { type: "last-prompt" },
]);

emit({
  type: "result",
  session_id: sessionId,
  result: shouldFail ? `Claude ошибка: ${prompt}` : `Claude готово: ${prompt}`,
  is_error: shouldFail,
  usage: {
    input_tokens: 80,
    cache_read_input_tokens: 20,
    output_tokens: 15,
  },
  total_cost_usd: 0.004,
});

process.exit(shouldFail ? 1 : 0);
