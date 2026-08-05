#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCodexExecutable } from "./src/providers/codex/codex-invocation.mjs";
import { JournalDatabase } from "./journal-database.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { writeTextAtomic } from "./src/infrastructure/persistence/state-store.mjs";
import {
  applyWorkLogTitleBackfill,
  buildTitleJobs,
  cachedTitleForJob,
  mergeGeneratedTitleCache,
  readJsonOr,
  titleGenerationPrompt,
} from "./src/interfaces/cli/work-log-title-backfill.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function runCodex({
  executable,
  model,
  effort,
  prompt,
  schemaFile,
  outputFile,
  cwd,
}) {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox", "read-only",
    "--model", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "--output-schema", schemaFile,
    "--output-last-message", outputFile,
    "--color", "never",
    "-C", cwd,
    "-",
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Codex title batch failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(prompt, "utf8");
  });
  return JSON.parse(await readFile(outputFile, "utf8"));
}

async function generateBatch(options, jobs, depth = 0) {
  try {
    const generated = await runCodex({
      ...options,
      prompt: titleGenerationPrompt(jobs),
    });
    const merged = mergeGeneratedTitleCache({ version: 1, titles: {} }, jobs, generated);
    if (!merged.missing.length) return generated;
    throw new Error(`Model omitted ${merged.missing.length} title(s)`);
  } catch (error) {
    if (jobs.length <= 1 || depth >= 4) {
      const job = jobs[0];
      return {
        titles: [{
          id: job.id,
          title: job.status === "completed" ? "Ход завершён" : "Ход отменён",
        }],
      };
    }
    const middle = Math.ceil(jobs.length / 2);
    const left = await generateBatch(options, jobs.slice(0, middle), depth + 1);
    const right = await generateBatch(options, jobs.slice(middle), depth + 1);
    return { titles: [...left.titles, ...right.titles] };
  }
}

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(sourceRoot, "..", "..");
const runtime = runtimeLayout(defaultRuntimeRoot());
const databaseFile = option("--database", path.join(runtime.dataDir, "journal.sqlite"));
const ledgerFile = option("--ledger", path.join(runtime.dataDir, "work-log-usage.json"));
const workLogFile = option("--work-log", path.join(workspaceRoot, "WORK_LOG.md"));
const cacheFile = option("--cache", path.join(runtime.dataDir, "migrations", "work-log-generated-titles.json"));
const through = option("--through", "2026-07-26");
const model = option("--model", "gpt-5.6-terra");
const effort = option("--effort", "low");
const batchSize = positiveInteger("--batch-size", 80);
const limit = process.argv.includes("--limit") ? positiveInteger("--limit", 1) : Number.POSITIVE_INFINITY;
const executable = await resolveCodexExecutable({ requested: option("--codex") });

const journalDatabase = new JournalDatabase(databaseFile);
let ledger;
try {
  ledger = await journalDatabase.loadLedger();
} finally {
  journalDatabase.close();
}
if (!Object.keys(ledger.turns ?? {}).length) {
  ledger = await readJsonOr(ledgerFile, { version: 8, turns: {} });
}
let cache = await readJsonOr(cacheFile, { version: 1, titles: {} });
const allJobs = buildTitleJobs(ledger, { through });
const jobs = allJobs.slice(0, limit);
const pending = jobs.filter((job) => !cachedTitleForJob(cache, job));

console.log(JSON.stringify({
  through,
  model,
  effort,
  total: allJobs.length,
  selected: jobs.length,
  cached: jobs.length - pending.length,
  pending: pending.length,
}, null, 2));

if (pending.length) {
  const temporary = await mkdtemp(path.join(tmpdir(), "agent-hub-titles-"));
  const schemaFile = path.join(temporary, "schema.json");
  const outputFile = path.join(temporary, "response.json");
  const schema = {
    type: "object",
    properties: {
      titles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string", minLength: 1, maxLength: 100 },
          },
          required: ["id", "title"],
          additionalProperties: false,
        },
      },
    },
    required: ["titles"],
    additionalProperties: false,
  };
  await writeFile(schemaFile, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  try {
    let complete = jobs.length - pending.length;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const generated = await generateBatch({
        executable,
        model,
        effort,
        schemaFile,
        outputFile,
        cwd: temporary,
      }, batch);
      const merged = mergeGeneratedTitleCache(cache, batch, generated);
      if (merged.missing.length) throw new Error(`Missing titles after fallback: ${merged.missing.length}`);
      cache = merged.cache;
      await writeTextAtomic(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
      complete += batch.length;
      console.log(`Generated ${complete}/${jobs.length}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes("--apply")) {
  if (jobs.length !== allJobs.length) throw new Error("Refusing to apply a limited title set");
  const result = await applyWorkLogTitleBackfill({
    ledger,
    jobs,
    cache,
    databaseFile,
    ledgerFile,
    workLogFile,
    projectRoot: workspaceRoot,
    projectionProjectRoots: [workspaceRoot],
  });
  console.log(`Updated: ${result.updated}`);
  console.log(`Backup: ${result.backupDirectory}`);
  console.log(`Database: ${databaseFile}`);
} else {
  console.log(`Cache: ${cacheFile}`);
  console.log("Generation complete. Add --apply to update journal.sqlite.");
}
