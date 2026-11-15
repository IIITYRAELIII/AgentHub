# ADR-HUB-363 — Allocation during original partial runtime retirement

Status: accepted for implementation, 2026-10-28.

The bounded runtime retirement owner deletes declared files before deleting the
raw manifest and root. Thus an admitted partial retirement can remove the final
physical Android update metadata copy while its allocation remains observable.
Requiring that deleted copy blocks a later freeze although the existing original
publication artifact owner still retains its exact metadata. Neither inventing a
replacement file nor ignoring missing unique content preserves the invariant.

The existing allocator still verifies every available runtime copy and groups
identical declared SHA-256/size content. Only when a group has no surviving copy
may it read the canonical original artifact for an exact pointer-retired/pruning
body. Current, previous and live-process pins are excluded. The raw manifest and
physical root must equal installed retirement custody and the original admitted
maintenance operation's candidate/binding. A read-only existing-store port does
not initialize schema, mutate receipts, settle the operation or acquire a writer.

The original artifact identity must hash to its canonical directory and match
the raw runtime manifest's source, revision and frozen artifact version. The
runtime artifact result and hash-verified PREPARED receipt bind the same raw
manifest/root and original publication operation/generation. The corresponding
Android artifact uses that whole identity and verifies its complete declared
payload; metadata must additionally match the runtime inventory's exact size,
SHA-256 and version code/name. The overall runtime-root alias may resolve to its
physical installation, but descendant links/type substitutions refuse. Final
pointer, root, original-operation and archive rechecks follow the final read.

An artifact proves original prepared content, not successful delivery of an
entire release. A historical partial release is never relabelled published or
Done by this reader. It grants no install, deletion, restart, restoration,
publication or maintenance-continuation authority and adds no version registry.
The compatibility boundary is an original admitted partial retirement with the
unchanged original frozen artifact/receipt. It can be removed once such retained
runtime entries have disappeared through normal retirement. No permanent archive
retention workflow, hardcoded installation/release identity or fallback chain is
introduced; unavailable unique content without complete custody still refuses.

Behavioral coverage uses the real native bounded batch and existing scheduler/
SQLite original: retirement removes mobile metadata, then allocation observes
its original artifact without changing pointer, manifest or maintenance receipt.
Missing/foreign/changed archive, manifest/root/original drift, unadmitted intent,
current/running/unretired missing body and drift during the archive read refuse.
Existing shared-copy/hash, allocation-floor and version grammar checks remain.
