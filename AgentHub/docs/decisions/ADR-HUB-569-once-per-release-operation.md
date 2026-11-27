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

Manual Done uses one installation proof per repository in the invocation.
Manual Complete uses published Git and exact Task-source pins. Its read-only
publication check does not hold the release repository lease while reading the
remote or the installation. Confirmation and native deletion retain the existing
Task revision, cleanup plan, worktree ownership and ref CAS. Previously admitted
cleanup retains its original proof format for recovery.

These proofs belong only to the active invocation. A continuation reads the
same durable operation but obtains its own fresh proof. The witnesses are not
persisted and add no authority to receipts, manifests or Task cards.

## Close a Task

The ordinary Close command records its intent, removes the Task's managed
working directories and local branches, and archives the card. It does not
require clean data, a delivery receipt, an installed runtime or a preview.
The same command is used for batch Close. The existing operation receipt and
Git owner guard coordinate interruptions and retries. Special delivery and
absorption modes retain their own evidence requirements when called explicitly.
