# ADR-HUB-393 — Native published synchronization with multiple merge bases

Status: accepted for implementation; source review and live adoption are separate.

The existing published-main/dev owner passed `merge-base --all` output to a
single-OID validator. A published selection and later Test integrations can share
five independent best bases. Picking one would invent a different three-way merge.

Keep the existing owner, native journal and review/delivery protocol. One base
retains exactly the old scalar identity field. Multiple bases use a sorted,
distinct complete OID set in the same identity; their hash is independent of Git's
output order. There is no conversion of old journals or approval retargeting.

The sequencer already performs native Git merges without a forced base. Extend
its selected-content check only for the exact published-sync one-result identity:
recompute all bases from its captured dev/publication parents and verify equality,
then replay that parent pair with Git's recursive virtual base. Replaying the
final head against its contained publication or forcing one base cannot provide
this proof. Compare the complete automatic tree, retaining the existing exact
reviewed conflict overrides. Ordinary selected Tasks keep their agreed-base check.

All original publication/generation, accepted selection, authenticated RM-recipient
review, repository/directory custody, primary/main/origin, process/lease, original
delivery intent and expected-old dev CAS checks stay in force. Lost delivery
replies keep the existing UNKNOWN and same-original readback. No schema, ledger,
publisher, public argument, manual ref repair or runtime installation is added.

Focused real Git/SQLite coverage integrates five independent commits in opposite
orders, asserts all five true bases, reproduces the scalar failure, and exercises
review, drift refusal, complete selected-file preservation and same finalize.
Legacy single-base and lost-effect cases retain their original assertions.
