# ADR-HUB330 — Reuse exact finalized relay attachments on retry

Status: Proposed; independent review required

The existing relay command and remote manifest own identity and delivery. A
failed sibling previously erased successful final files; the next same-command
poll fetched their chunk bodies again before checking the existing local file.
Transport codes nested in an error cause could also be treated as permanent
because the classifier depended on an English message fragment.

Keep the same command/attachment IDs, queue leases, protocol, backoff and
deadlines. Preserve finalized files under their existing history lifetime. Read
and validate the complete remote manifest before verifying an exact existing
command-owned file and skipping its chunk bodies. Reject changed bytes and
never overwrite them or borrow another command's paths. No new cache or ledger
is introduced, and started chunk groups still drain before a poll settles.

Restore the previously reviewed read-only inspector in the current source
context. Forward existing original-ID tracing through the client composition;
the existing trace worker owns persistence and bounds. Observation grants no
delivery, retry or deployment authority. Source acceptance alone cannot prove
the cause or recovery of an incident whose deployed queue inspector is absent.

Focused evidence exercises a failed third attachment, preserved verified
siblings, exact-ID reuse, another command's isolation, corrupt-file refusal,
throwing telemetry, and failed/successful spans read after trace-worker reopen.
Existing inspector auth, privacy, paging and no-write controls remain intact.
