import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
const prompt = args.at(-1) ?? "";
const holdDirectory = process.env.FAKE_CLAUDE_HOLD_DIR ?? "";
const transcriptRoot = process.env.FAKE_CLAUDE_TRANSCRIPT_ROOT ?? "";
const holdMatch = /\[hold:([^\]]+)\]/.exec(prompt);
const childMatch = /\[child:([^\]]+)\]/.exec(prompt);
const shouldFail = prompt.includes("[fail]");
const cwd = process.cwd();

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
});

process.exit(shouldFail ? 1 : 0);
