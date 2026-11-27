# ADR-HUB-569 — One source proof per release operation

## Decision

A manual main-to-dev invocation verifies the installed bytes once. Its existing
owner checks the live release, remote and local repository binding, and change
metadata for the exact files covered by that proof before effect and settlement.
The final delivery check precedes fresh dev custody and checkout readback. A
failed check preserves the original recovery record.

Await verifies exact selected Git history once using commit and tree IDs with
replace refs disabled for that proof. At each promotion boundary it rechecks
the current selection and publication authority and any durable returned-Test
evidence used by the proof. Installed local-source bytes are verified once, with
the scoped file metadata, live pointer, origin and retained source rechecked at
later boundaries. Distinct retained compositions keep their own verification.

Manual Done and Complete also reuse one byte proof per exact repository and
result set during their own invocation. Their existing Task revision, ownership
and cleanup checks still run with the current release and Task leases.

These proofs belong only to the active invocation. A continuation reads the
same durable operation but obtains its own fresh proof. The witnesses are not
persisted and add no authority to receipts, manifests or Task cards.
