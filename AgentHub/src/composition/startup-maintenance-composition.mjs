import { readFile } from "node:fs/promises";
import { cleanupOrphanedClaudeRunOutputs } from "../providers/claude/claude-run-io.mjs";
import { cleanupTaskGitIndexes } from "../infrastructure/filesystem/task-git-diff.mjs";

export async function runStartupMaintenance({
  config,
  stateLoadFailed,
  taskRuns,
  pinnedTaskTitlesFile,
  taskMetadata,
  logger = console,
}) {
  try {
    if (stateLoadFailed) {
      logger.warn("Skipping Claude run cleanup because runtime state could not be recovered.");
    } else {
      const activeClaudeRunPaths = taskRuns.values()
        .filter((run) => run.provider === "claude" && !run.observer)
        .flatMap((run) => [run.claudeOutputPath, run.claudeErrorPath])
        .filter(Boolean);
      const removed = await cleanupOrphanedClaudeRunOutputs(config.dataDir, activeClaudeRunPaths);
      if (removed.length) logger.log(`Removed ${removed.length} orphaned Claude run file(s).`);
    }
  } catch (error) {
    logger.warn("Cannot clean orphaned Claude run files:", error.message);
  }

  try {
    const removed = await cleanupTaskGitIndexes(config.dataDir);
    if (removed) logger.log(`Removed ${removed} orphaned task diff index(es).`);
  } catch (error) {
    logger.warn("Cannot clean orphaned task diff indexes:", error.message);
  }

  try {
    const savedPinnedTitles = JSON.parse(await readFile(pinnedTaskTitlesFile, "utf8"));
    taskMetadata.restorePinnedTitles(savedPinnedTitles);
  } catch (error) {
    if (error?.code !== "ENOENT") logger.error("Cannot read pinned task titles:", error.message);
  }
}
