# Captured Codex rollout evidence

A copied runtime may contain rollout paths in terminal audit pending turns,
historical subagent queues, saved positions, active runs and generated attachment
sources. Preparing a catalog and isolating CODEX_HOME does not give authority to
read those paths.

The recording `CodexTerminalAudit` excludes the entire rollout audit before
discovery, project fallback resolution, pending polling, file stat/scan or
historical import. Pending turns, positions, historical checkpoints and projection
flags remain evidence. Its persisted `lastRun` reports `status: excluded`, counts
for pending threads/turns, historical files and positions, and
`cycleComplete: false`. It never advances the captured completion boundary or
clears pending work. Repeated exclusion does not repeatedly append diagnostics.

The shared rollout filesystem entry points also enforce the recording marker
policy before file I/O, worker dispatch or directory discovery. This covers
session/tail/usage/activity readers and direct subagent recovery even when a
saved `run.rolloutPath` bypasses ordinary discovery. A requested source path
rejects with `CONTOUR_ROLLOUT_EXCLUDED`; absence of a path remains absence of
evidence. Pure parsers are unchanged. Terminal attachment resolution excludes
rollout reads and generated-path imports before inspecting their source files.

Provider terminal recovery through the literal RPC transport remains active.
The full synthetic Hub test restores captured audit queues, starts one queued
command, replaces the Hub, recovers its explicit provider terminal with the
same IDs and commits it once. It also verifies recording outbox acknowledgement,
inert background jobs and retained rollout queue paths. Focused poisoned-reader
tests verify that audit, readers and attachment import never touch the source
sentinel. Rollout accounting and attachment recovery from captured files remain
explicit contour parity exclusions.
