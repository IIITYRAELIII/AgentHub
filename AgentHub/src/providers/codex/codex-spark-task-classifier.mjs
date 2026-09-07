import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { captureProcess } from "../../infrastructure/process/process-capture.mjs";
import { TELEGRAM_BUNDLE_TRIAGE_INSTRUCTIONS } from "../../domain/task-board-task.mjs";
import { resolveCodexExecutable } from "./codex-invocation.mjs";

const DASHBOT_STREAM_META_KEY = "task_board.spark_stream_id";
const DASHBOT_THREAD_META_KEY = "task_board.spark_thread_id";
const DASHBOT_STREAM_NAME = "DashBot";

const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "correctedText", "category", "workspaceId", "confidence", "reason"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 160 },
    description: { type: "string", maxLength: 20_000 },
    correctedText: { type: "string", minLength: 1, maxLength: 20_000 },
    category: { type: "string", enum: ["task", "note", "unknown"] },
    workspaceId: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", maxLength: 1000 },
  },
});

export function taskClassifierPrompt({ text, workspaces, inputKind = "plain" }) {
  const bundleInstructions = inputKind === "telegram-forward-bundle" ? [
    ...TELEGRAM_BUNDLE_TRIAGE_INSTRUCTIONS,
  ] : [];
  return [
    "Ты сортировщик личных записей Agent Hub.",
    "Исправь только явные опечатки, пунктуацию и регистр, не меняя смысл и не добавляя фактов.",
    "Верни отдельные title и description. title — краткий понятный заголовок задачи, description — её полное исправленное содержание без потери деталей.",
    "Если содержательная запись короткая, перенеси её целиком в title, а description верни пустым.",
    "category=note используй для фильмов, сериалов, игр, книг, идей на потом и справочных заметок.",
    "category=task используй для действий, которые нужно выполнить.",
    "Выбери workspaceId только когда назначение однозначно следует из текста.",
    "Если не уверен, верни workspaceId=null и низкую confidence.",
    ...bundleInstructions,
    `Доступные Workspace: ${JSON.stringify(workspaces)}`,
    `Исходная запись: ${JSON.stringify(String(text))}`,
  ].join("\n");
}

export function parseTaskClassifierResult(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Spark вернул некорректный результат");
  }
  const correctedText = String(parsed.correctedText ?? "").trim();
  const title = String(parsed.title ?? "").replace(/\s+/gu, " ").trim();
  const description = String(parsed.description ?? "").trim();
  const category = String(parsed.category ?? "unknown").trim().toLowerCase();
  const confidence = Number(parsed.confidence);
  if (!correctedText) throw new Error("Spark не вернул исправленный текст");
  if (!title) throw new Error("Spark не вернул заголовок");
  if (title.length > 160) throw new Error("Spark вернул слишком длинный заголовок");
  if (description.length > 20_000) throw new Error("Spark вернул слишком длинное описание");
  if (!["task", "note", "unknown"].includes(category)) throw new Error("Spark вернул неизвестную категорию");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Spark вернул некорректную уверенность");
  }
  return {
    title,
    description,
    correctedText,
    category,
    workspaceId: parsed.workspaceId == null ? null : String(parsed.workspaceId).trim() || null,
    confidence,
    reason: String(parsed.reason ?? "").trim(),
  };
}

export function parseTaskClassifierThreadId(stdout) {
  for (const line of String(stdout ?? "").split(/\r?\n/gu)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "thread.started" && String(event.thread_id ?? "").trim()) {
        return String(event.thread_id).trim();
      }
    } catch {}
  }
  return null;
}

export function ensureDashBotStream(workspaceCatalog, {
  model = "gpt-5.3-codex-spark",
  projectRoot = "",
} = {}) {
  if (!workspaceCatalog) throw new TypeError("workspaceCatalog is required");
  const experiments = workspaceCatalog.ensureExperiments();
  const storedStreamId = String(workspaceCatalog.meta(DASHBOT_STREAM_META_KEY) ?? "").trim();
  const storedStream = storedStreamId ? workspaceCatalog.stream(storedStreamId) : null;
  if (storedStream?.workspaceId === experiments.id) {
    return workspaceCatalog.moveStreamToStart(storedStream.id);
  }
  const existing = workspaceCatalog.hierarchy()
    .find((workspace) => workspace.id === experiments.id)?.streams
    .find((stream) => stream.name === DASHBOT_STREAM_NAME);
  const stream = existing ?? workspaceCatalog.createStream({
    workspaceId: experiments.id,
    name: DASHBOT_STREAM_NAME,
    settings: {
      provider: "codex",
      model,
      project: projectRoot,
      sandbox: "read-only",
    },
  });
  workspaceCatalog.setMeta(DASHBOT_STREAM_META_KEY, stream.id);
  return workspaceCatalog.moveStreamToStart(stream.id);
}

export class CodexSparkTaskClassifier {
  constructor({
    requestedExecutable = "",
    executableArgs = [],
    projectRoot,
    model = "gpt-5.3-codex-spark",
    timeoutMs = 90_000,
    resolveExecutable = resolveCodexExecutable,
    runProcess = captureProcess,
    stopProcess,
    workspaceCatalog,
    streamId,
  } = {}) {
    this.requestedExecutable = requestedExecutable;
    this.executableArgs = executableArgs;
    this.projectRoot = projectRoot;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.resolveExecutable = resolveExecutable;
    this.runProcess = runProcess;
    this.stopProcess = stopProcess;
    this.workspaceCatalog = workspaceCatalog;
    this.streamId = streamId;
  }

  async classify(input) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-triage-"));
    const schemaFile = path.join(directory, "output.schema.json");
    const outputFile = path.join(directory, "result.json");
    try {
      await writeFile(schemaFile, `${JSON.stringify(OUTPUT_SCHEMA)}\n`, "utf8");
      const executable = await this.resolveExecutable({ requested: this.requestedExecutable });
      const prompt = taskClassifierPrompt(input);
      const threadId = this.#threadId();
      const commonArgs = [
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--model", this.model,
        "--output-schema", schemaFile,
        "--output-last-message", outputFile,
        "--json",
      ];
      const args = threadId ? [
        ...this.executableArgs,
        "exec",
        "resume",
        ...commonArgs,
        threadId,
        prompt,
      ] : [
        ...this.executableArgs,
        "exec",
        "--sandbox", "read-only",
        "--color", "never",
        "--cd", this.projectRoot,
        ...commonArgs,
        prompt,
      ];
      const result = await this.runProcess(executable, args, {
        cwd: this.projectRoot,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: 256 * 1024,
        stopProcess: this.stopProcess,
      });
      if (result.error) throw result.error;
      if (result.code !== 0) {
        throw new Error(`Codex Spark завершился с кодом ${result.code}: ${String(result.stderr ?? "").trim()}`);
      }
      const completedThreadId = parseTaskClassifierThreadId(result.stdout) ?? threadId;
      if (!completedThreadId) throw new Error("Codex Spark не вернул идентификатор Thread");
      await this.#bindThread(completedThreadId);
      return parseTaskClassifierResult(await readFile(outputFile, "utf8"));
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  #threadId() {
    if (!this.workspaceCatalog || !this.streamId) return null;
    const stored = String(this.workspaceCatalog.meta(DASHBOT_THREAD_META_KEY) ?? "").trim();
    const storedBinding = stored
      ? this.workspaceCatalog.resolveThread({ provider: "codex", threadId: stored })
      : null;
    if (storedBinding?.streamId === this.streamId) return stored;
    const active = this.workspaceCatalog.activeThread(this.streamId);
    return active?.provider === "codex" ? active.threadId : null;
  }

  async #bindThread(threadId) {
    if (!this.workspaceCatalog || !this.streamId) return;
    await this.workspaceCatalog.rebindThread(
      { provider: "codex", threadId },
      {
        streamId: this.streamId,
        projectRoot: this.projectRoot,
        source: "created",
      },
    );
    await this.workspaceCatalog.setMeta(DASHBOT_THREAD_META_KEY, threadId);
  }
}
