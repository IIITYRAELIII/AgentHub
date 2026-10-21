# ADR-0073 — Bound Thread numbering and recoverable provider names

Status: accepted source policy, 2026-10-06 (HUB-292; live rollout held).

## Cause and decision

The former formatter omitted Thread numbers. Creation named only after settings
and state awaits, its command owner hid post-create errors and overwrote the
title, and rotation bypassed naming. Startup could replace a successfully resumed
Thread merely because naming failed. These are source causes, not attribution
of a particular screenshot or proof about individual live native titles.

Keep one catalog allocator and the existing Hub naming service. In the catalog's
short SQLite transaction, allocate binding `position`, retain per-Stream
high-water in catalog metadata, and persist a content-free exact naming intent.
No parallel naming counter, delivery outbox, provider DB writer or timer exists.
The title is `Workspace - Stream N`; explicit Stream names are preserved, unnamed
Streams use `Поток <ordinal>`, N is the binding position. The bounded formatter
preserves N. A rebind/split remains a move, keeps source high-water, preserves
target uniqueness and supersedes any unfinished old naming intent.
The service revalidates the captured binding/intent after asynchronous steps,
before each further provider dispatch and local projection, and after completion
before returning a title. Supersession is an explicit authority-changed error,
not transient pending naming. A previously authorized provider write may finish
after a move; its late reply cannot pin/save the obsolete title or trigger an
automatic rename for the new Stream. No SQLite transaction is held over RPC.

Team Lead explicitly approved lazy atomic baseline initialization from max
confirmed existing positions (new Stream: zero). Existing Sirius positions 1..53
would yield 54 if no intervening bind. This does not claim recovery of unknown
removed/moved history. Legacy titles are not automatically changed. Migration
adds only catalog metadata on an explicit binding/move, not a startup scan or
mass rewrite; the baseline guard stays necessary for stores without high-water.

Create and rotation attempt naming even after a post-bind setup/projection
failure; the original failure is still returned, separately from naming failure.
Resume and pre-input recovery use the same exact pending intent. A lost naming
reply reconciles through metadata readback; no new Thread/number is allocated.
Pending creation/rotation reuses its existing catalog target. An acknowledged
name plus matching exact readback and durable local projection completes the
intent. A timeout is not absence evidence. Startup retains a successfully resumed
Thread on later failure while keeping definitive missing/wrong-project recovery.

Claude's current adapter has no native rename capability: canonical Hub naming
completes with `providerRename=unsupported`, without transcript writes, synthetic
turns or perpetual retry. Native Claude rename is explicitly outside this change.

## Evidence and deployment boundary

Installed signed OpenAI codex-cli 0.160.1 offline-generated schemas verify
`thread/name/set` requires string `threadId`/`name`, its response is an object,
and `thread/read` accepts `includeTurns=false`. The supported API documentation
is <https://learn.chatgpt.com/docs/app-server#api-overview>.
Schema generation creates no provider session. Behavioral tests use disposable
SQLite and production-shaped fake provider adapters through the actual owners;
they are not native live-title evidence. No live Thread/database mutation or
Test/dev/Contour adoption is authorized by this source decision.

Preserved: exact provider/Thread/Stream ownership, compaction transfer/readiness,
message/turn identity and payload, settings error truthfulness, short mutation
queue/retry boundaries, user custom titles and release precedence. Legacy
correction is a bounded read-only preview followed only by the existing supported
`task.rename` command after explicit approval; no automatic legacy repair.
