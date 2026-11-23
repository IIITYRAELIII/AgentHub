import { createHash } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { codexVisualizationIdentity } from "../../domain/codex-visualization-reference.mjs";
import { assertCodexRolloutReadAllowed } from "../../infrastructure/filesystem/test-contour-rollout-policy.mjs";
import { IgnoredTraceRecord } from "./codex-trace-record.mjs";

const MAX_HTML_BYTES = 1_000_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,180}\.html$/iu;
const RESERVED_NAME = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])\./iu;
const MARKER = /^\uE200visualize\uE202(\{.*\})\uE201$/u;

function findReference(text, markerHash) {
  let fence = null;
  for (const line of String(text ?? "").split(/\r\n?|\n/u)) {
    if (fence) {
      const closing = /^[ ]{0,3}([\x60~]+)[ \t]*$/u.exec(line);
      if (closing?.[1][0] === fence[0] && closing[1].length >= fence.length
        && [...closing[1]].every((character) => character === fence[0])) fence = null;
      continue;
    }
    const opening = /^[ ]{0,3}(\x60{3,}|~{3,})/u.exec(line);
    if (opening) { fence = opening[1]; continue; }
    const marker = line.trim();
    const match = marker.length <= 4096 && MARKER.exec(marker);
    if (!match || createHash("sha256").update(marker).digest("hex") !== markerHash) continue;
    const value = JSON.parse(match[1]);
    if (typeof value?.path === "string" && value.path === value.path.trim()) {
      return value.path;
    }
  }
  return "";
}

// This read is addressed, not part of projection or polling. Keep one bounded
// JSONL record at a time and stop at the requested terminal event.
async function* rolloutRecords(handle, size) {
  let parts = [];
  let bytes = 0;
  let ignored = null;
  for (let offset = 0; offset < size;) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    const chunk = buffer.subarray(0, bytesRead);
    offset += bytesRead;
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(10, start);
      const part = chunk.subarray(start, newline < 0 ? chunk.length : newline);
      start = newline < 0 ? chunk.length : newline + 1;
      if (!ignored && bytes + part.length > MAX_LINE_BYTES) {
        ignored = new IgnoredTraceRecord(MAX_LINE_BYTES);
        for (const previous of parts) ignored.push(previous);
        parts = [];
      }
      if (ignored) ignored.push(part);
      else if (part.length) { parts.push(part); bytes += part.length; }
      if (newline < 0) continue;
      if (ignored) ignored.finish();
      else if (bytes) yield JSON.parse(Buffer.concat(parts, bytes).toString("utf8"));
      parts = [];
      bytes = 0;
      ignored = null;
    }
  }
}

function pathKey(value) {
  const normal = path.resolve(value);
  return process.platform === "win32" ? normal.toLowerCase() : normal;
}

function artifactScope(value, attachmentDirectory, threadId) {
  if (!value || value.includes("\0") || !path.isAbsolute(value)
    || /^[\\/]{2}/u.test(value) || value.split(/[\\/]/u).some((part) => part === "..")) return null;
  const source = path.resolve(value);
  const name = path.basename(source);
  if (!FILE_NAME.test(name) || RESERVED_NAME.test(name)) return null;
  const parent = pathKey(path.dirname(source));
  if (parent === pathKey(attachmentDirectory)) return { source, name, legacy: true };
  if (parent === pathKey(path.join(attachmentDirectory, "visualizations", threadId))) {
    return { source, name, legacy: false };
  }
  return null;
}

function recordedCreation(changes) {
  const entries = Array.isArray(changes) ? changes.map((change) => [change.path, change]) : Object.entries(changes ?? {});
  return entries.filter(([file, change]) => (
    typeof file === "string" && path.isAbsolute(file)
    && (change?.type === "add" || change?.kind?.type === "add")
  )).map(([file]) => pathKey(file));
}

function assistantText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "";
}

async function findTurnArtifact(rolloutPath, options, identity) {
  const { attachmentDirectory } = options;
  const transcript = await open(rolloutPath, "r");
  const created = new Set();
  let startedAt = NaN;
  let exactFinal = null;
  let sessionVerified = false;
  try {
    const before = await transcript.stat();
    if (!before.isFile() || !before.size) return null;
    for await (const { type, payload, timestamp } of rolloutRecords(transcript, before.size)) {
      if (!sessionVerified) {
        if (type !== "session_meta" || (payload?.id ?? payload?.session_id) !== identity.threadId
          || (payload.session_id && payload.session_id !== identity.threadId)) return null;
        sessionVerified = true;
        continue;
      }
      if (type !== "event_msg" || payload?.turn_id !== identity.turnId) continue;
      if (payload.thread_id && payload.thread_id !== identity.threadId) return null;
      if (payload.type === "task_started") {
        if (Number.isFinite(startedAt)) return null;
        startedAt = Date.parse(timestamp);
      }
      if (!Number.isFinite(startedAt)) continue;
      const item = payload.item;
      if (payload.type === "item_completed" && item?.type === "FileChange" && item.status === "completed") {
        for (const file of recordedCreation(item.changes)) {
          if (artifactScope(file, attachmentDirectory, identity.threadId)) created.add(file);
        }
      }
      if (payload.type === "item_completed" && item?.type === "AgentMessage"
        && item.phase === "final_answer" && item.id === identity.itemId) {
        if (exactFinal !== null) return null;
        exactFinal = assistantText(item.content);
      }
      if (payload.type !== "task_complete") continue;
      if (payload.error || payload.aborted) return null;
      const completedAt = Date.parse(timestamp);
      const final = assistantText(payload.last_agent_message);
      const finalPath = findReference(final, identity.markerHash);
      const ownedPath = identity.itemId === identity.turnId + ":agent:final"
        ? finalPath : findReference(exactFinal, identity.markerHash);
      if (!ownedPath || ownedPath !== finalPath || !Number.isFinite(completedAt) || completedAt < startedAt) return null;
      const artifact = artifactScope(ownedPath, attachmentDirectory, identity.threadId);
      if (!artifact || (artifact.legacy && !created.has(pathKey(artifact.source)))) return null;
      const after = await transcript.stat();
      if (after.size < before.size || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) return null;
      return { ...artifact, startedAt, completedAt };
    }
    return null;
  } finally {
    await transcript.close();
  }
}

function sameArtifact(left, right) {
  return right.isFile() && right.nlink === 1 && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readArtifact(artifact, attachmentDirectory, threadId) {
  const root = await realpath(attachmentDirectory);
  const expected = artifact.legacy ? path.join(root, artifact.name)
    : path.join(root, "visualizations", threadId, artifact.name);
  const resolved = await realpath(artifact.source);
  if (pathKey(resolved) !== pathKey(expected)) return null;
  const initial = await lstat(artifact.source);
  if (!initial.isFile() || initial.nlink !== 1 || initial.size < 1 || initial.size > MAX_HTML_BYTES
    || (artifact.legacy && (initial.mtimeMs < artifact.startedAt || initial.mtimeMs > artifact.completedAt))) return null;
  const handle = await open(resolved, "r");
  try {
    if (!sameArtifact(initial, await handle.stat())) return null;
    const bytes = Buffer.alloc(initial.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== initial.size || !sameArtifact(initial, await handle.stat())
      || pathKey(await realpath(artifact.source)) !== pathKey(expected)
      || !sameArtifact(initial, await stat(expected))) return null;
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    if (!/<[a-z][a-z0-9-]*[\s>/]/iu.test(html)) return null;
    return /^\s*(?:<!doctype\b|<html\b|<head\b|<body\b)/iu.test(html) ? null : html;
  } finally {
    await handle.close();
  }
}

export async function readCodexVisualization(rolloutPath, options) {
  const identity = codexVisualizationIdentity(options);
  if (!rolloutPath || !identity || !options.attachmentDirectory) return null;
  try {
    assertCodexRolloutReadAllowed("readCodexVisualization");
    const artifact = await findTurnArtifact(rolloutPath, options, identity);
    return artifact ? await readArtifact(artifact, options.attachmentDirectory, identity.threadId) : null;
  } catch {
    return null;
  }
}
