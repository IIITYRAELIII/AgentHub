# ADR-HUB-429: Reconcile exact missing prepared metadata

Status: accepted for implementation

An ancestor directory removal can leave an intact prepared checkout and
checkpoint while removing its hash-addressed manifest. Replaying preparation or
copying a convenient frozen manifest would substitute authority and lose the
original failure. The retained generation capture already binds the original
checkpoint digest, commit, tree, manifest digest and source location.

Use the existing ReleaseGitWorkspaceService recovery owner and recovery CLI for
an explicit restore-prepared-evidence-v1 mode. Derive both namespaces from the
registered primary and original generation identity. Reverse only the capture
owner's relocation and added preparedCandidate field. Require equality with the
current checkpoint's original hash, alongside fresh physical and Git custody.
Persist an exclusive proof-bound metadata admission before publishing those
exact bytes. Reentry reads that same admission. No new state owner, release
original, generation, candidate, Task transition or publication effect is added.

The compatibility input is removable once the addressed metadata has been
restored and ordinary acceptance has advanced beyond that prepared checkpoint.
The generic owner remains useful for exact retained-capture reconciliation; it
never supplies missing or guessed release authority.

Behavioral coverage exercises a real prepared checkout and immutable generation,
missing evidence, exact byte recovery, stale checkpoint and refs, corrupt capture,
foreign Workspace and occupied-file refusal, durable admission interruption and
same-request readback. The original historical deletion receipt proves ancestor
removal, not the presence of an individual manifest before removal.
