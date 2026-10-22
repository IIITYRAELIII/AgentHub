# ADR-0110 — Recover expired transport without discarding draft bytes

Status: proposed, 2026-10-16.

A ready preview proves local preparation, not a surviving remote upload receipt.
The older client coupled its durable Blob UUID with the first transport UUID and
asked for file selection after an expired receipt, even while original bytes
were still available. A generic not-found/expired tooltip does not prove TTL.

Keep the existing Blob/logical upload identity and message identity. The existing
composer file owner stores a separate current uploadAttemptId and attemptedAt
alongside verified bytes. The uploader may renew once per explicit invocation
only after upgraded authoritative expired state, or absent state beyond the old
deadline/without a legacy saved timestamp. It uses a fresh UUID, never clears a
tombstone, repeats an expired begin, extends the old expiry or replays a message.
The pending UUID is reused after persistence failure; no begin leaves until a
previously durable record has been committed and read back. Lost responses and
reload resume the saved attempt. Memory-only files claim current-page recovery
only. Cancellation, generic 404, content conflicts and unavailable bytes fail
visibly without renewal. The UI shows recovery; text and sibling files retain
their existing owners. Upload completion still precedes message admission.

The local HTTP and desktop adapters expose the same explicit transport state as
the Worker. Existing bounded tracing joins logical upload/message identities to
the physical attempt ID and allows only enumerated receipt states, without file
names, bytes, URLs, credentials or raw errors.

Legacy records without uploadAttemptId use their original upload UUID. This
read compatibility is removable after the existing seven-day Blob retention
contains no pre-change records. It is not a second receipt owner or new route.
Unknown legacy server responses remain closed; they never grant fresh attempts.

Checks cover real authenticated HTTP expiration, immutable old tombstone, saved
attempt/reload/lost-response continuity, persistence failure, bounded renewal,
missing bytes and one rendered message with unchanged siblings. Production
incident attribution and actual installed-after latency remain separate evidence.
