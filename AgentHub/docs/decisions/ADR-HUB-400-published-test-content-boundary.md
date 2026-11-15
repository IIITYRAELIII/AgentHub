# Consume the sealed publication boundary in ordinary Test content replay

Status: accepted implementation decision; independent review and delivery pending.

## Context

An ordinary Task can retain its immutable agreed base while fast-forwarding to
an authenticated publication. Its Test intent already seals the exact
repository publication in `nativeHistoryAuthority.publishedMetadata`. History
and metadata admission consume that proof, but content replay formerly always
forced the older Task base. When dev moved an inherited published block while
the Task left it unchanged, that replay demanded a second copy of the block.
The clean native candidate already preserved the own correction and current dev.

## Decision

Consume the existing sealed context inside the same selected-content owner,
only for a single ordinary `native-dev-merge-v1` Task with exact Task/result/dev
identity and publication commit/tree. The published revision must be the exact
unique Git merge base of the captured parents and descend from the immutable
Task base. Use it only as the content replay lower boundary. Do not rewrite the
Task base, original intent, native history, journal, publication or any ref.

The owning TaskGit caller still authenticates and rereads publication/origin,
source/custody, lease and Task/CAS identity at its existing boundaries. Historical
intents without the context get no new evidence. Other selection policies and
other merge-base shapes retain their prior content replay. No path is ignored;
missing own changes and changed identities still refuse. There is no new API,
review capability, ledger, release subset, Await baseline exception or retry.

## Evidence and limits

The real public MCP/SQLite/Git regression fast-forwards a Task, moves an already
published block in dev and retains a small own correction. The parent rejects
that exact inherited path; the correction accepts the native candidate, preserves
both histories/current Test bytes and survives SQLite reopen. Negative cases
cover missing/foreign publication, changed source and bound identity, and lost
own content. Existing deletion/mode/ancestor-loss guards remain exercised.

This fixes ordinary Test replay only. It neither repairs an old UNKNOWN receipt
nor changes Await's current-baseline ancestry requirement. Current compatible
source validation and production application are separate owner actions.
