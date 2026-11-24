# ADR-HUB-530. Continue an interrupted native Await

An ordinary Await can check out its verified candidate and then fail its third
authority check before the PreRelease ref changes. The prior checkpoint still
describes the old candidate. Treating this as published notes prevents the
original pending workflow from settling. The rollback probe may also mask the
failure that initiated it.

The existing RM operation reconciliation and the same candidate owner
continue the exact ordinary Await under their existing locks. The candidate
owner checks the original journal, standalone checkout, index, ref and prior
checkpoint, then verifies the completed native merge graph and selected
content. It reproduces the complete prepared manifest at the current Task
CAS, plan and publication. The existing Task transition records the exact
promotion permit in the same SQLite writer transaction that checks for
durable cancellation. A cancellation recorded before admission leaves the
old ref and checkpoint. After admission any written Git effects belong to
the original, and the terminal Task CAS still checks cancellation. The
owner advances only the missing ref, symbolic HEAD
and checkpoint effects, then uses the existing workflow CAS and receipt
settlement. After a committed Task CAS, the same owner can finish the
original journal write without replaying the CAS or Git promotion. Later
readback requires a journal addressed to the original.
An unaddressed v1 journal can enter only at the proven detached pre-ref
boundary. The already-published notes archive keeps its existing protocol.

If any prerequisite differs, reconciliation preserves the evidence. When
promotion fails and rollback cannot be verified, the current receipt carries
both the initial phase/error and the separate rollback/readback error.
An already lost initial cause cannot be reconstructed from the rollback probe.
