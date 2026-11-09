# Addressed cancellation and bounded Desktop receipt projection

## Context

After release 2.1.5 completed, three old release notifications were canonically
queued while the live RAM maps contained none. The public cancel action refused
before reaching the existing ledger owner. An addressed owner cancellation then
committed, but two cards remained visible in the user's window. The observed
recent-receipt limits and facade-local revision counter could exclude that
change. These observations establish separate failures, without identifying a
single exclusive cause for the historical window. Full Desktop snapshots also
exceeded the existing response bound because Task presentation was repeated.

## Decision

Keep the message command ledger as the only cancellation owner. Resolve missing
RAM items by their exact client/deferred identity, retain the existing state and
revision CAS, and persist before removing projections or cleaning attachments.
Legacy ID-only lookup searches only cancellable active states and refuses an
ambiguous match. Exact cancelled requests return durable readback. Tombstones
retain Stream and cancellation scope alongside their original identity.

Read SQLite data_version and local total_changes as the live ledger revision.
Snapshots combine recent receipts with exact unresolved client-requested IDs
through point reads. The identity set participates in cache eligibility without
creating another unbounded cache. The client sends addressed snapshots through
the existing authenticated control POST/bridge, preserving GET for ordinary
unaddressed reads and existing response ordering fences. Canonical cancellation
retires its outgoing projection and queue count. A canonical queued projection
can invoke the same public cancel action when RAM is missing.

Desktop Task summaries defer large presentation fields to the existing addressed
read and preserve detailsRevision. Default Task APIs keep full presentation.
Editing stays disabled until the exact full card arrives. This bounds wire
payloads without changing the existing response limit. The current store still
reads Task rows before projecting summaries, so this change does not claim a
reduction in database row-read cost.

## Evidence and limits

Maintained tests cover real SQLite cancellation through Desktop control without
RAM, foreign/ambiguous/accepted/unknown refusals, terminal retention, external
connection invalidation, addressed receipts beyond 100 later receipts, and large
Task presentation over the actual Desktop response boundary. Edge tests exercise
the shipped client and public cancellation owner, queue cards/counts and deferred
editing. Timings contain original IDs and boundary timestamps, without message
payloads. Fixture rendering does not establish removal in the existing user
window before reviewed delivery and a fresh live readback.
