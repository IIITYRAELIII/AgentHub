# ADR-0274 — Same-Blob upload attempt persistence

## Observed boundary

The local 2.0.3 incident at 2026-10-28 09:33 involved three logical uploads.
The second failed `attempt-persist` / browser
`attachment-storage-write` four times at about five seconds before its begin.
The first file's origin begin/chunk/complete succeeded in 63/15/41 ms. Subsequent
explicit user activity eventually reached begin for the second file; this is
retained history, not an agent replay or proof of the earlier user-visible send.

`persistUploadAttempt` unnecessarily re-entered full Blob admission: it traversed
all retained records, then rewrote and verified the file for a same-key metadata
change. A blocked unrelated archive traversal could therefore prevent a prepared
file's begin. Additionally the local storage `TimeoutError` was translated into
"Нет связи с Agent Hub" by generic connection classification. The traces prove
the storage boundary, not the physical cause of the user's IndexedDB delay or a
server/disk/internet fault.

## Decision

Keep the existing IndexedDB `files` record as sole Blob/attempt authority. A
durable existing Blob updates only its exact key in one transaction, preserving
the stored Blob, immutable descriptor and original retention timestamp. Its
existing attempt must equal the captured original or the desired identical
pending attempt; another attempt cannot be overwritten. An already committed
identical pending attempt is reconciled by readback without another write.
The committed record still receives full Blob/hash and exact attempt verification
before begin. There is no memory fallback after an uncertain durable write.

If the record was removed by ordinary retention, this becomes ordinary new Blob
admission through the existing quota/retention owner in the same five-second I/O
budget. No capacity/expiry extension, second metadata journal, database upgrade,
automatic retry, new upload/message identity or automatic user operation is added.
Initial saves and reload hydration retain their existing byte verification.

A typed `attachmentStorageCode` is a browser storage failure even when its name is
`TimeoutError` or `AbortError`; the existing paused card shows that reason instead
of declaring the Hub disconnected. Genuine transport failures retain their normal
classification. This is not a new warning/toast for silent preparation failures.

## Evidence and limits

Focused executable regressions hold the unrelated archive, verify same-key
progress, preserve unknown committed-attempt identity without rewriting, refuse
foreign attempts/corrupt bytes and retain capacity checks for missing records.
Production-browser cases exercise the actual composer/IndexedDB and paused error.
Original user sends, drafts, resumes and cancellations are not replayed.
Candidate-client/isolated fixture evidence is not installed production AFTER;
the release owner applies the reviewed result and verifies that separately.
