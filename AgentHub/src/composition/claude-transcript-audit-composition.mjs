import { scanClaudeHistoricalTranscriptFile } from "../providers/claude/claude-work-log.mjs";
import { conciseTurnTitle } from "../application/turn-title.mjs";

export function createClaudeTranscriptAuditComposition({
  projectRoot,
  projectionProjectRoots,
  findProject,
  workLogUsageStore,
  maximumTrackedTranscripts = 2_000,
  logger = console,
}) {
  const transcriptVersions = new Map();

  async function audit(snapshots) {
    const records = [];
    for (const snapshot of snapshots ?? []) {
      const transcriptPath = String(snapshot?.transcriptPath ?? "").trim();
      const sessionId = String(snapshot?.sessionId ?? "").trim();
      const project = snapshot?.cwd ? findProject(snapshot.cwd) : null;
      if (!transcriptPath || !sessionId || !project) continue;
      const auditVersion = Number(snapshot.modifiedAtMs) || 0;
      if (transcriptVersions.get(transcriptPath) === auditVersion) continue;
      const scan = await scanClaudeHistoricalTranscriptFile(transcriptPath);
      const taskTitle = String(snapshot.title ?? scan.session?.title ?? "").trim();
      for (const turn of scan.turns ?? []) {
        records.push({
          ...turn,
          provider: "claude",
          threadId: sessionId,
          turnId: turn.turnId,
          projectRoot: project.path,
          taskTitle,
          title: turn.body ? conciseTurnTitle(turn.body, turn.status) : turn.title,
          taskThreadId: sessionId,
          parentThreadId: "",
          aggregateOnly: false,
          provisional: false,
          changedFiles: [],
          diff: "",
        });
      }
      transcriptVersions.set(transcriptPath, auditVersion);
      while (transcriptVersions.size > maximumTrackedTranscripts) {
        transcriptVersions.delete(transcriptVersions.keys().next().value);
      }
    }
    if (!records.length) return;
    const result = await workLogUsageStore.recordAutomaticBatchAndProject({
      records,
      projectRoot,
      projectionProjectRoots,
    });
    if (result.recorded || result.updated) {
      logger.log(`Audited Claude journal turns: ${result.recorded} added, ${result.updated} updated`);
    }
  }

  return { audit };
}
