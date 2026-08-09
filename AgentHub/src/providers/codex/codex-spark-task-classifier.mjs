import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { captureProcess } from "../../infrastructure/process/process-capture.mjs";
import { resolveCodexExecutable } from "./codex-invocation.mjs";

const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["correctedText", "category", "workspaceId", "confidence", "reason"],
  properties: {
    correctedText: { type: "string", minLength: 1, maxLength: 20_000 },
    category: { type: "string", enum: ["task", "note", "unknown"] },
    workspaceId: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", maxLength: 1000 },
  },
});

export function taskClassifierPrompt({ text, workspaces }) {
  return [
    "Ты сортировщик личных записей Agent Hub.",
    "Исправь только явные опечатки, пунктуацию и регистр, не меняя смысл и не добавляя фактов.",
    "category=note используй для фильмов, сериалов, игр, книг, идей на потом и справочных заметок.",
    "category=task используй для действий, которые нужно выполнить.",
    "Выбери workspaceId только когда назначение однозначно следует из текста.",
    "Если не уверен, верни workspaceId=null и низкую confidence.",
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
  const category = String(parsed.category ?? "unknown").trim().toLowerCase();
  const confidence = Number(parsed.confidence);
  if (!correctedText) throw new Error("Spark не вернул исправленный текст");
  if (!["task", "note", "unknown"].includes(category)) throw new Error("Spark вернул неизвестную категорию");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Spark вернул некорректную уверенность");
  }
  return {
    correctedText,
    category,
    workspaceId: parsed.workspaceId == null ? null : String(parsed.workspaceId).trim() || null,
    confidence,
    reason: String(parsed.reason ?? "").trim(),
  };
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
  } = {}) {
    this.requestedExecutable = requestedExecutable;
    this.executableArgs = executableArgs;
    this.projectRoot = projectRoot;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.resolveExecutable = resolveExecutable;
    this.runProcess = runProcess;
    this.stopProcess = stopProcess;
  }

  async classify(input) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-triage-"));
    const schemaFile = path.join(directory, "output.schema.json");
    const outputFile = path.join(directory, "result.json");
    try {
      await writeFile(schemaFile, `${JSON.stringify(OUTPUT_SCHEMA)}\n`, "utf8");
      const executable = await this.resolveExecutable({ requested: this.requestedExecutable });
      const args = [
        ...this.executableArgs,
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--model", this.model,
        "--output-schema", schemaFile,
        "--output-last-message", outputFile,
        "--color", "never",
        "--cd", this.projectRoot,
        taskClassifierPrompt(input),
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
      return parseTaskClassifierResult(await readFile(outputFile, "utf8"));
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
