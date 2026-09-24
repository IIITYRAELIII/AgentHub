import { writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

const source = path.resolve(argument("--source", path.resolve(import.meta.dirname, "../..")));
const sourceCommit = String(argument("--source-commit", "working-tree") ?? "working-tree");
const calls = Math.max(1, Number(argument("--calls", "36")) || 36);
const accountDelayMs = Math.max(1, Number(argument("--account-delay-ms", "50")) || 50);
const root = await mkdtemp(path.join(os.tmpdir(), "hub-message-admission-bench-"));

try {
  const { TaskDiffStore } = await import(pathToFileURL(path.join(
    source, "src/infrastructure/persistence/task-diff-store.mjs",
  )));
  const { createWorkLogUsageStore } = await import(pathToFileURL(path.join(
    source, "src/application/work-log-usage-store.mjs",
  )));
  const filePath = path.join(root, "task-diffs.json");
  const sizes = [3_003_813, 2_248_476, ...Array.from({ length: 97 }, () => 21_000), 0];
  const entries = sizes.map((size, index) => [`thread-${index}`, "x".repeat(size)]);
  await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  const taskDiffs = new TaskDiffStore({ filePath, limit: 100 });
  await taskDiffs.load();
  const diffSamples = [];
  const diffStarted = performance.now();
  await Promise.all(Array.from({ length: calls }, async () => {
    const started = performance.now();
    await taskDiffs.set("thread-99", "");
    diffSamples.push(performance.now() - started);
  }));
  const diffTotalMs = performance.now() - diffStarted;

  const records = new Map();
  let tail = Promise.resolve();
  let accountReads = 0;
  const repository = {
    ledger: { version: 9, turns: {} },
    enqueue(operation) {
      const queued = tail.catch(() => {}).then(operation);
      tail = queued;
      return queued;
    },
    async getRecord({ provider, threadId, turnId }) {
      return records.get(`${provider}\0${threadId}\0${turnId}`) ?? null;
    },
    async saveRecord(key, record) { records.set(key, record); return { revision: records.size }; },
    async save() {}, async payload() { return { html: "", version: "" }; },
    async replaceProjection() { return { projected: true }; }, async close() {},
  };
  const usage = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    resolveAccount: async () => {
      accountReads += 1;
      await new Promise((resolve) => setTimeout(resolve, accountDelayMs));
      return { account: { type: "chatgpt", email: "bench@example.test", planType: "pro" } };
    },
  });
  const accountStarted = performance.now();
  await Promise.all(Array.from({ length: calls }, (_, index) => usage.recordAutomaticAndProject({
    provider: "codex", threadId: "bench-thread", turnId: `turn-${index}`,
    projectRoot: root, status: "completed", completedAt: "2026-09-21T00:00:00.000Z",
    body: `answer-${index}`, deferProjection: true,
  })));
  const accountTotalMs = performance.now() - accountStarted;
  const result = {
    source,
    sourceCommit,
    calls,
    taskDiffBytes: Buffer.byteLength(JSON.stringify(entries, null, 2), "utf8") + 1,
    taskDiff: {
      totalMs: diffTotalMs,
      p50Ms: percentile(diffSamples, 0.5),
      p95Ms: percentile(diffSamples, 0.95),
      maxMs: percentile(diffSamples, 1),
    },
    account: {
      totalMs: accountTotalMs,
      reads: accountReads,
      expectedRecords: calls,
      exactRecords: records.size,
    },
    correctness: {
      exactRecords: records.size === calls,
      unchangedDiff: taskDiffs.get("thread-99") === "",
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!Object.values(result.correctness).every(Boolean)) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
