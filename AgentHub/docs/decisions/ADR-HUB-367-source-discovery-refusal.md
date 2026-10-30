# ADR-HUB-367 — Seal claim refusal at source discovery

An installed-runtime directory can be selected accidentally as the Workspace
source. Read-only Git identity discovery then fails before preparation, but its
generic error used to leave an unsealed UNKNOWN claim and obstruct another
admission after routing was corrected.

The existing Task Git owner now issues a live invocation-bound source-admission
proof only from its read-only discovery boundary, with the Task lease still
owned. The existing catalog refusal transaction seals exact intake/arguments,
Task CAS and selected project locator before terminal failure. No ref/worktree,
dependency preparation or Task assignment has entered that boundary. Later
preparation failures and forged/serialized errors cannot obtain the proof.

The same original ID remains refused; an explicitly requested fresh claim after
correcting routing uses the ordinary owner and preserves existing managed dirty
bytes. Lost terminal writes use the existing sealed-refusal readback, including
the original invalid locator. No new table, writer or recovery API is introduced.

Historical unsealed claims remain UNKNOWN. Their error text, present absence of
effects and this new proof type grant no retrospective authority. Existing
forward custody still requires its exact authorization and source/retirement
conditions; in particular its clean-source requirement is not bypassed to adopt
another executor's dirty checkout. This change neither repairs provider routing
or compaction nor authorizes installed runtime replacement.

The source-refusal locator is retained whole, without an added path-length
ceiling or truncation. A positively owned discovery failure is not invalidated
by locator length. Nonempty string/NUL format checks and exact invocation,
caller, lease and Task CAS evidence remain required. The bounded regression
controls only process-never-started at the exact read-only discovery spawn;
it does not claim native Windows execution with a long cwd.
