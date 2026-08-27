import { scanClaudeHistoricalTranscriptFile } from "../providers/claude/claude-work-log.mjs";
import { conciseTurnTitle } from "../application/turn-title.mjs";

export function createClaudeTranscriptAuditComposition({
  projectRoot,
  projectionProjectRoots,
  findProject,
  workLogUsageStore,
  scanTranscript = scanClaudeHistoricalTranscriptFile,
  maximumTranscriptBytes = 16 * 1024 * 1024,
  maximumTrackedTranscripts = 2_000,
  logger = console,
}) {
  const transcriptVersions = new Map();
  const oversizedTranscripts = new Set();

  function rememberVersion(transcriptPath, auditVersion) {
    transcriptVersions.set(transcriptPath, auditVersion);
    while (transcriptVersions.size > maximumTrackedTranscripts) {
      const oldestPath = transcriptVersions.keys().next().value;
      transcriptVersions.delete(oldestPath);
      oversizedTranscripts.delete(oldestPath);
    }
  }

  async function audit(snapshots) {
    const records = [];
    for (const snapshot of snapshots ?? []) {
      const transcriptPath = String(snapshot?.transcriptPath ?? "").trim();
      const sessionId = String(snapshot?.sessionId ?? "").trim();
      const project = snapshot?.cwd ? findProject(snapshot.cwd) : null;
      if (!transcriptPath || !sessionId || !project) continue;
      const auditVersion = Number(snapshot.modifiedAtMs) || 0;
      if (transcriptVersions.get(transcriptPath) === auditVersion) continue;
      if (snapshot.active === true) continue;
      const transcriptSizeBytes = Math.max(0, Number(snapshot.transcriptSizeBytes) || 0);
      if (transcriptSizeBytes > maximumTranscriptBytes) {
        rememberVersion(transcriptPath, auditVersion);
        if (!oversizedTranscripts.has(transcriptPath)) {
          oversizedTranscripts.add(transcriptPath);
          logger.warn?.(
            `Skipped Claude historical transcript audit above ${maximumTranscriptBytes} bytes: ${transcriptPath}`,
          );
        }
        continue;
      }
      rememberVersion(transcriptPath, auditVersion);
      let scan;
      try {
        scan = await scanTranscript(transcriptPath);
      } catch (error) {
        if (transcriptVersions.get(transcriptPath) === auditVersion) {
          transcriptVersions.delete(transcriptPath);
        }
        throw error;
      }
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
