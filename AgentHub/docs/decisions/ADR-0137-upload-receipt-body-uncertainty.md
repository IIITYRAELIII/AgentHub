# ADR-0137 — Unread upload receipts retain transport uncertainty

## Context

The optimized client uses an acknowledged begin receipt without an extra GET.
Its JSON helper used to replace a rejected body read with an empty object. A
committed begin with lost response bytes therefore failed the next ID/protocol
check as “Несовпадение загрузки файла”, even when the owner stored the correct
identity. The same problem can misclassify status or completion replies.

## Decision

Keep the owner, protocol, checksums, attempt deadline and message identity.
Propagate the existing response-json trace failure and report successful HTTP
headers with an unread body as an unconfirmed receipt. Retain the original saved
attempt and bytes; only explicit resume queries that attempt's status. Do not
automatically begin again, renew the ID, retransmit committed chunks or submit a
message. A decoded foreign ID/protocol remains a strict refusal. An unreadable
non-success HTTP reply keeps its HTTP error with no invented recovery state.

## Evidence and limits

Real isolated HTTP tests commit begin/chunks/complete through the normal owner,
then lose only response bodies. Explicit later resume reuses one attempt and
does not repeat acknowledged work. Tests also retain strict foreign receipt and
generic error refusal. Existing response-json trace stages report failure rather
than successful parsing of an invented empty object; no contents or secrets are
recorded. This corrects a reproduced client defect, not the independently
investigated server latency or proof of the original user's exact browser state.
