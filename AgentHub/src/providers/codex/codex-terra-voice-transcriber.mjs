import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { captureProcess } from "../../infrastructure/process/process-capture.mjs";
import { resolveCodexExecutable } from "./codex-invocation.mjs";
import { parseTaskClassifierThreadId } from "./codex-spark-task-classifier.mjs";

const STREAM_META_KEY = "task_board.terra_voice_stream_id";
const THREAD_META_KEY = "task_board.terra_voice_thread_id";
const STREAM_NAME = "DashBot Terra";

const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["transcript"],
  properties: {
    transcript: { type: "string", minLength: 1, maxLength: 50_000 },
  },
});

export function voiceTranscriptPrompt(rawTranscript) {
  return [
    "Ты редактор автоматической расшифровки голосовых сообщений для Dashboard Agent Hub.",
    "Исправь явные ошибки распознавания, пунктуацию и регистр.",
    "Не сокращай, не пересказывай, не добавляй факты и не меняй смысл.",
    "Верни только структурированный результат по схеме.",
    `Черновая расшифровка: ${JSON.stringify(String(rawTranscript))}`,
  ].join("\n");
}

export function parseVoiceTranscriptResult(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const transcript = String(parsed?.transcript ?? "").trim();
  if (!transcript) throw new Error("Terra не вернула расшифровку");
  if (transcript.length > 50_000) throw new Error("Terra вернула слишком длинную расшифровку");
  return transcript;
}

function pinTerraStreamSecond(workspaceCatalog, streamId, firstStreamId) {
  const first = firstStreamId ? workspaceCatalog.stream(firstStreamId) : null;
  if (first) workspaceCatalog.moveStreamToStart(first.id);
  const stream = workspaceCatalog.stream(streamId);
  const siblings = workspaceCatalog.hierarchy()
    .find((workspace) => workspace.id === stream.workspaceId)?.streams ?? [];
  const before = siblings.find((item) => item.id !== stream.id && item.id !== first?.id) ?? null;
  return workspaceCatalog.reorderStream(stream.id, before?.id ?? null);
}

export function ensureDashBotTerraStream(workspaceCatalog, {
  firstStreamId = null,
  model = "gpt-5.6-terra",
  projectRoot = "",
} = {}) {
  if (!workspaceCatalog) throw new TypeError("workspaceCatalog is required");
  const other = workspaceCatalog.ensureExperiments();
  const storedStreamId = String(workspaceCatalog.meta(STREAM_META_KEY) ?? "").trim();
  const stored = storedStreamId ? workspaceCatalog.stream(storedStreamId) : null;
  const existing = stored?.workspaceId === other.id
    ? stored
    : workspaceCatalog.hierarchy()
      .find((workspace) => workspace.id === other.id)?.streams
      .find((stream) => stream.name === STREAM_NAME);
  let stream = existing ?? workspaceCatalog.createStream({
    workspaceId: other.id,
    name: STREAM_NAME,
    settings: {
      provider: "codex",
      model,
      project: projectRoot,
      sandbox: "read-only",
    },
  });
  const settings = {
    ...(stream.settings ?? {}),
    provider: "codex",
    model,
    project: projectRoot,
    sandbox: "read-only",
  };
  if (JSON.stringify(settings) !== JSON.stringify(stream.settings ?? {})) {
    stream = workspaceCatalog.updateStreamSettings(stream.id, settings);
  }
  workspaceCatalog.setMeta(STREAM_META_KEY, stream.id);
  return pinTerraStreamSecond(workspaceCatalog, stream.id, firstStreamId);
}

export class CodexTerraVoiceTranscriber {
  #tail = Promise.resolve();

  constructor({
    requestedExecutable = "",
    executableArgs = [],
    projectRoot,
    model = "gpt-5.6-terra",
    pythonExe,
    transcribeScript,
    whisperModel = "large-v3-turbo",
    whisperModelDir = "",
    whisperDevice = "cuda",
    resolveExecutable = resolveCodexExecutable,
    runProcess = captureProcess,
    stopProcess,
    workspaceCatalog,
    streamId,
    logger = console,
  } = {}) {
    Object.assign(this, {
      requestedExecutable,
      executableArgs,
      projectRoot,
      model,
      pythonExe,
      transcribeScript,
      whisperModel,
      whisperModelDir,
      whisperDevice,
      resolveExecutable,
      runProcess,
      stopProcess,
      workspaceCatalog,
      streamId,
      logger,
    });
  }

  transcribe(filePath) {
    const run = this.#tail.catch(() => {}).then(() => this.#transcribe(filePath));
    this.#tail = run;
    return run;
  }

  async #transcribe(filePath) {
    const local = await this.runProcess(this.pythonExe, [this.transcribeScript, path.resolve(filePath)], {
      cwd: this.projectRoot,
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 128 * 1024,
      stopProcess: this.stopProcess,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        WHISPER_MODEL: this.whisperModel,
        WHISPER_MODEL_DIR: this.whisperModelDir,
        WHISPER_DEVICE: this.whisperDevice,
      },
    });
    if (local.error) throw local.error;
    if (local.code !== 0) {
      throw new Error(`Распознавание голоса завершилось с кодом ${local.code}: ${String(local.stderr ?? "").trim()}`);
    }
    const rawTranscript = String(local.stdout ?? "").trim();
    if (!rawTranscript) throw new Error("В голосовом сообщении не удалось распознать речь");
    try {
      return await this.#refine(rawTranscript);
    } catch (error) {
      this.logger.warn(`Cannot refine voice transcript with Terra: ${error.message}`);
      return rawTranscript;
    }
  }

  async #refine(rawTranscript) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-voice-terra-"));
    const schemaFile = path.join(directory, "output.schema.json");
    const outputFile = path.join(directory, "result.json");
    try {
      await writeFile(schemaFile, `${JSON.stringify(OUTPUT_SCHEMA)}\n`, "utf8");
      const executable = await this.resolveExecutable({ requested: this.requestedExecutable });
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
      const prompt = voiceTranscriptPrompt(rawTranscript);
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
        timeoutMs: 90_000,
        maxOutputBytes: 256 * 1024,
        stopProcess: this.stopProcess,
      });
      if (result.error) throw result.error;
      if (result.code !== 0) {
        throw new Error(`Codex Terra завершился с кодом ${result.code}: ${String(result.stderr ?? "").trim()}`);
      }
      const completedThreadId = parseTaskClassifierThreadId(result.stdout) ?? threadId;
      if (!completedThreadId) throw new Error("Codex Terra не вернул идентификатор Thread");
      this.#bindThread(completedThreadId);
      return parseVoiceTranscriptResult(await readFile(outputFile, "utf8"));
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  #threadId() {
    if (!this.workspaceCatalog || !this.streamId) return null;
    const stored = String(this.workspaceCatalog.meta(THREAD_META_KEY) ?? "").trim();
    const binding = stored
      ? this.workspaceCatalog.resolveThread({ provider: "codex", threadId: stored })
      : null;
    if (binding?.streamId === this.streamId) return stored;
    const active = this.workspaceCatalog.activeThread(this.streamId);
    return active?.provider === "codex" ? active.threadId : null;
  }

  #bindThread(threadId) {
    if (!this.workspaceCatalog || !this.streamId) return;
    this.workspaceCatalog.rebindThread(
      { provider: "codex", threadId },
      {
        streamId: this.streamId,
        projectRoot: this.projectRoot,
        source: "created",
      },
    );
    this.workspaceCatalog.setMeta(THREAD_META_KEY, threadId);
  }
}
