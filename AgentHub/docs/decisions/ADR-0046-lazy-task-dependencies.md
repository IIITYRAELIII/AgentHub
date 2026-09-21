# ADR-0046: Prepare Task dependencies on demand

Status: Accepted for HUB-235 implementation; deployment follows the Task release.

## Decision

Ordinary claim/start prepares Git only. The agent explicitly requests
`hub_task_claim` with `dependency_mode=ensure` before dependency-dependent work,
or `verify` after suspected installed-state damage. Dependencies remain local
to the Task worktree. Matching successful preparation is reused using source
inputs, runtime identity, linked-package expectations and the installed lock hash;
full installed-tree traversal is reserved for installation, changed evidence and
explicit verification. An ordinary agent turn is not an invalidation event.

Sparse settings are applied on creation or changed selection/mode. Repeated
preparation checks the existing selection and merge admission without rewriting
unchanged settings or modifying dirty files.

npm holds the Task and dependency leases after releasing the dev lease. Its
process guard has Task scope; Git and legacy guards retain repository scope.
This prevents another owner changing the same Task while allowing an unrelated
Task to integrate into dev during installation.

## Evidence and limits

Behavioral coverage exercises claim modes, preserved dirty files, concurrent
dev integration during npm, same-Task serialization, unchanged reuse, manifest
and linked-package changes, hidden-lock damage and explicit verification.
Existing bounded validation, durable failure evidence and unproven-process
fences remain in force. Reuse does not detect arbitrary package-file edits with
unchanged inputs and hidden lock; suspected damage must use `verify`.

Previously created unknown MCP receipts are not reclassified by this change.
The new claim argument requires deployment of the updated Hub tool bridge.
