import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { isMainModule } from "../../infrastructure/process/main-module.mjs";
import { readWindowsRolloutProcesses } from "./codex-runtime-owner.mjs";
import { readCodexRolloutActivity } from "../../../task-catalog.mjs";

const DEFAULT_KEEP_RECENT_IMAGES = 4;
const DEFAULT_MIN_RECLAIM_BYTES = 1024 * 1024;
const IMAGE_STUB_PREFIX = "[Older image omitted from active context";

function hashImage(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function imageReferences(value) {
  const result = [];
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (current.type === "input_image" && typeof current.image_url === "string") {
      result.push(current.image_url);
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    pending.push(...Object.values(current));
  }
  return result;
}

function compactionImageReferences(entry) {
  const result = [];
  for (const message of entry?.payload?.replacement_history ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (let index = 0; index < message.content.length; index += 1) {
      const content = message.content[index];
      if (content?.type !== "input_image" || typeof content.image_url !== "string") continue;
      result.push({
        container: message.content,
        index,
        imageUrl: content.image_url,
        hash: hashImage(content.image_url),
      });
    }
  }
  return result;
}

function sanitizeCompaction(entry, rawImageHashes, {
  keepRecentImages = DEFAULT_KEEP_RECENT_IMAGES,
} = {}) {
  const references = compactionImageReferences(entry);
  const duplicated = references.filter((reference) => rawImageHashes.has(reference.hash));
  const removableCount = Math.max(0, duplicated.length - keepRecentImages);
  const removed = duplicated.slice(0, removableCount);
  for (const reference of removed) {
    reference.container[reference.index] = {
      type: "input_text",
      text: `${IMAGE_STUB_PREFIX}; original remains in rollout; do not reload unless the user explicitly requests it or the task cannot be completed without it; sha256:${reference.hash.slice(0, 16)}]`,
    };
  }
  return {
    changed: removed.length > 0,
    imageCount: references.length,
    duplicateImageCount: duplicated.length,
    removedImageCount: removed.length,
    removedImageBytes: removed.reduce(
      (total, reference) => total + Buffer.byteLength(reference.imageUrl),
      0,
    ),
  };
}

function sameSignature(left, right) {
  return left?.size === right?.size && left?.mtimeMs === right?.mtimeMs;
}

async function writeLine(stream, line) {
  if (!stream.write(`${line}\n`, "utf8")) await once(stream, "drain");
}

async function finishStream(stream) {
  const completed = new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
  });
  stream.end();
  await completed;
}

async function transformCodexRollout(rolloutPath, {
  keepRecentImages = DEFAULT_KEEP_RECENT_IMAGES,
  outputFile = null,
} = {}) {
  const rawImageHashes = new Set();
  const input = createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const output = outputFile
    ? createWriteStream(outputFile, { encoding: "utf8", flags: "wx" })
    : null;
  const result = {
    compactionCount: 0,
    transformedCompactionCount: 0,
    rawImageCount: 0,
    rawUniqueImageCount: 0,
    compactionImageCount: 0,
    duplicateImageCount: 0,
    removedImageCount: 0,
    removedImageBytes: 0,
    reclaimedBytes: 0,
    outputBytes: 0,
  };
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      let outputLine = line;
      if (line.includes('"input_image"') || line.includes('"type":"compacted"')) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid rollout JSON at line ${lineNumber}: ${error.message}`);
        }
        if (entry?.type === "compacted") {
          result.compactionCount += 1;
          const sanitized = sanitizeCompaction(entry, rawImageHashes, { keepRecentImages });
          result.compactionImageCount += sanitized.imageCount;
          result.duplicateImageCount += sanitized.duplicateImageCount;
          result.removedImageCount += sanitized.removedImageCount;
          result.removedImageBytes += sanitized.removedImageBytes;
          if (sanitized.changed) {
            result.transformedCompactionCount += 1;
            outputLine = JSON.stringify(entry);
            result.reclaimedBytes += (
              Buffer.byteLength(line) - Buffer.byteLength(outputLine)
            );
          }
        } else {
          const images = imageReferences(entry);
          result.rawImageCount += images.length;
          for (const image of images) rawImageHashes.add(hashImage(image));
        }
      }
      result.outputBytes += Buffer.byteLength(outputLine) + 1;
      if (output) await writeLine(output, outputLine);
    }
    result.rawUniqueImageCount = rawImageHashes.size;
    if (output) await finishStream(output);
    return result;
  } catch (error) {
    output?.destroy();
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function analyzeCodexRolloutContext(rolloutPath, {
  keepRecentImages = DEFAULT_KEEP_RECENT_IMAGES,
  statFile = stat,
} = {}) {
  const before = await statFile(rolloutPath);
  const analysis = await transformCodexRollout(rolloutPath, { keepRecentImages });
  const after = await statFile(rolloutPath);
  if (!sameSignature(before, after)) {
    return {
      ...analysis,
      rolloutPath,
      stable: false,
      sourceBytes: after.size,
      signature: { size: after.size, mtimeMs: after.mtimeMs },
    };
  }
  return {
    ...analysis,
    rolloutPath,
    stable: true,
    sourceBytes: before.size,
    signature: { size: before.size, mtimeMs: before.mtimeMs },
  };
}

export async function windowsRolloutIdleState(rolloutPath, {
  platform = process.platform,
  readActivity = readCodexRolloutActivity,
  processProbe = readWindowsRolloutProcesses,
  agentHubPid = 0,
} = {}) {
  const activity = await readActivity(rolloutPath);
  if (activity.running || activity.activeTurnIds?.length) {
    return { idle: false, reason: "active-turn", activity };
  }
  if (platform !== "win32") {
    return { idle: false, reason: "idle-process-check-unavailable", activity };
  }
  const snapshot = await processProbe(rolloutPath, { agentHubPid });
  const processIds = [...new Set((snapshot?.rootProcessIds ?? [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))];
  if (processIds.length) {
    return { idle: false, reason: "rollout-open", processIds, activity };
  }
  return { idle: true, reason: "idle", processIds: [], activity };
}

export async function sanitizeCodexRolloutContext(rolloutPath, {
  keepRecentImages = DEFAULT_KEEP_RECENT_IMAGES,
  minReclaimBytes = DEFAULT_MIN_RECLAIM_BYTES,
  analysis = null,
  statFile = stat,
  idleState = windowsRolloutIdleState,
  renameFile = rename,
  unlinkFile = unlink,
} = {}) {
  const inspected = analysis ?? await analyzeCodexRolloutContext(rolloutPath, {
    keepRecentImages,
    statFile,
  });
  if (!inspected.stable) return { ...inspected, applied: false, reason: "rollout-changed" };
  if (inspected.reclaimedBytes < minReclaimBytes) {
    return { ...inspected, applied: false, reason: "below-threshold" };
  }
  const idle = await idleState(rolloutPath);
  if (!idle.idle) return { ...inspected, applied: false, reason: idle.reason, idle };

  const temporaryFile = path.join(
    path.dirname(rolloutPath),
    `.${path.basename(rolloutPath)}.${process.pid}.${randomUUID()}.context.tmp`,
  );
  try {
    const transformed = await transformCodexRollout(rolloutPath, {
      keepRecentImages,
      outputFile: temporaryFile,
    });
    if (transformed.reclaimedBytes !== inspected.reclaimedBytes
      || transformed.removedImageCount !== inspected.removedImageCount) {
      return { ...inspected, applied: false, reason: "rollout-changed-during-rewrite" };
    }
    const current = await statFile(rolloutPath);
    if (!sameSignature(inspected.signature, current)) {
      return { ...inspected, applied: false, reason: "rollout-changed-during-rewrite" };
    }
    const finalIdle = await idleState(rolloutPath);
    if (!finalIdle.idle) {
      return { ...inspected, applied: false, reason: finalIdle.reason, idle: finalIdle };
    }
    const sourceMode = current.mode;
    await chmod(temporaryFile, sourceMode);
    const handle = await open(temporaryFile, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameFile(temporaryFile, rolloutPath);
    const finalInfo = await statFile(rolloutPath);
    return {
      ...inspected,
      ...transformed,
      applied: true,
      reason: "sanitized",
      sourceBytes: current.size,
      outputBytes: finalInfo.size,
      reclaimedBytes: current.size - finalInfo.size,
      signature: { size: finalInfo.size, mtimeMs: finalInfo.mtimeMs },
    };
  } finally {
    await unlinkFile(temporaryFile).catch(() => {});
  }
}

async function collectRollouts(directory, result) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectRollouts(target, result);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      result.push(target);
    }
  }
}

export async function discoverCodexRollouts({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  statFile = stat,
} = {}) {
  const result = [];
  await collectRollouts(path.join(codexHome, "sessions"), result);
  const withInfo = await Promise.all(result.map(async (rolloutPath) => ({
    rolloutPath,
    info: await statFile(rolloutPath),
  })));
  return withInfo.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);
}

export class CodexRolloutContextSanitizer {
  constructor({
    enabled = true,
    keepRecentImages = DEFAULT_KEEP_RECENT_IMAGES,
    minReclaimBytes = DEFAULT_MIN_RECLAIM_BYTES,
    maxFilesPerPass = 8,
    codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    discover = discoverCodexRollouts,
    analyze = analyzeCodexRolloutContext,
    sanitize = sanitizeCodexRolloutContext,
    idleState = windowsRolloutIdleState,
    logger = console,
  } = {}) {
    this.enabled = enabled;
    this.keepRecentImages = keepRecentImages;
    this.minReclaimBytes = minReclaimBytes;
    this.maxFilesPerPass = maxFilesPerPass;
    this.codexHome = codexHome;
    this.discover = discover;
    this.analyze = analyze;
    this.sanitize = sanitize;
    this.idleState = idleState;
    this.logger = logger;
    this.running = false;
  }

  async sanitizeOne(rolloutPath, { info = null } = {}) {
    if (!this.enabled) return { rolloutPath, applied: false, reason: "disabled" };
    if (info && info.size < this.minReclaimBytes) {
      return { rolloutPath, applied: false, reason: "below-threshold" };
    }
    const idle = await this.idleState(rolloutPath);
    if (!idle.idle) {
      return {
        rolloutPath,
        applied: false,
        reason: idle.reason,
        idle,
      };
    }
    const analysis = await this.analyze(rolloutPath, {
      keepRecentImages: this.keepRecentImages,
    });
    if (analysis.reclaimedBytes < this.minReclaimBytes) {
      return { ...analysis, applied: false, reason: "below-threshold" };
    }
    const result = await this.sanitize(rolloutPath, {
      keepRecentImages: this.keepRecentImages,
      minReclaimBytes: this.minReclaimBytes,
      analysis,
      idleState: this.idleState,
    });
    if (result.applied) {
      this.logger.log(
        `Sanitized Codex rollout context ${path.basename(rolloutPath)}: `
          + `${result.removedImageCount} duplicate image(s), `
          + `${Math.round(result.reclaimedBytes / 1024)} KiB reclaimed.`,
      );
    }
    return result;
  }

  async runForRollout(rolloutPath) {
    if (!this.enabled) return { rolloutPath, applied: false, reason: "disabled" };
    if (this.running) return { rolloutPath, applied: false, reason: "sanitizer-busy" };
    this.running = true;
    try {
      return await this.sanitizeOne(rolloutPath);
    } catch (error) {
      this.logger.warn(
        `Cannot sanitize Codex rollout context ${path.basename(rolloutPath)}: ${error.message}`,
      );
      return { rolloutPath, applied: false, reason: "error", error };
    } finally {
      this.running = false;
    }
  }

  async runOnce() {
    if (!this.enabled || this.running) return { applied: 0, skipped: 0, reclaimedBytes: 0 };
    this.running = true;
    const summary = { applied: 0, skipped: 0, reclaimedBytes: 0, results: [] };
    try {
      const rollouts = await this.discover({ codexHome: this.codexHome });
      for (const { rolloutPath, info } of rollouts.slice(0, this.maxFilesPerPass)) {
        if (info.size < this.minReclaimBytes) continue;
        try {
          const result = await this.sanitizeOne(rolloutPath, { info });
          summary.results.push(result);
          if (result.applied) {
            summary.applied += 1;
            summary.reclaimedBytes += result.reclaimedBytes;
          } else if (result.reason !== "below-threshold") {
            summary.skipped += 1;
          }
        } catch (error) {
          summary.skipped += 1;
          this.logger.warn(
            `Cannot sanitize Codex rollout context ${path.basename(rolloutPath)}: ${error.message}`,
          );
        }
      }
      return summary;
    } finally {
      this.running = false;
    }
  }
}

function parseArguments(argv) {
  const args = [...argv];
  const command = args.shift() ?? "inspect";
  let rolloutPath = "";
  let keepRecentImages = DEFAULT_KEEP_RECENT_IMAGES;
  let minReclaimBytes = DEFAULT_MIN_RECLAIM_BYTES;
  while (args.length) {
    const value = args.shift();
    if (value === "--keep-recent-images") {
      keepRecentImages = Number(args.shift());
    } else if (value === "--min-reclaim-bytes") {
      minReclaimBytes = Number(args.shift());
    } else if (!rolloutPath) {
      rolloutPath = path.resolve(value);
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }
  if (!["inspect", "sanitize"].includes(command)) {
    throw new Error("Usage: node codex-rollout-context.mjs inspect|sanitize <rollout.jsonl>");
  }
  if (!rolloutPath) throw new Error("A rollout JSONL path is required");
  if (!Number.isSafeInteger(keepRecentImages) || keepRecentImages < 0) {
    throw new Error("--keep-recent-images must be a non-negative integer");
  }
  if (!Number.isSafeInteger(minReclaimBytes) || minReclaimBytes < 0) {
    throw new Error("--min-reclaim-bytes must be a non-negative integer");
  }
  return { command, rolloutPath, keepRecentImages, minReclaimBytes };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = options.command === "sanitize"
    ? await sanitizeCodexRolloutContext(options.rolloutPath, options)
    : await analyzeCodexRolloutContext(options.rolloutPath, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.command === "sanitize" && !result.applied) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
