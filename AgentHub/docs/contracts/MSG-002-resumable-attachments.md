# MSG-002 — Resumable attachment upload

The owned local HTTP gateway keeps its primary upstream idle pool below the
Node owner's five-second timeout (currently two seconds). It does not enable
mutating-request retries or change operator-defined additional upstreams.
Transient proxy failures expose their bounded upload stage and HTTP status while
retaining the original draft. Explicit resume reconciles the same upload receipt;
known committed chunks/ready files are not retransmitted. A diagnostic HTTP UUID
joins browser, authenticated origin and sanitized gateway-error spans without
replacing any logical/attempt/message identity. No raw request content enters
those spans (ADR-0083). Deployment still belongs to the existing gateway/runtime
owner; these settings cannot be applied by starting a competing listener.


## Authority and transitions

An upload is preparation, not message admission. Its client-created UUID and
authenticated owner bind immutable name, MIME type and declared byte length.
Message retries retain their original clientUserMessageId independently of the
upload UUID. Upload progress, finalization and cancellation cannot send a message
or infer provider acceptance.

The local AttachmentUploadService owns durable staging receipts and parts. The
public Worker Durable Object owns remote receipts and parts. Each store is the
sole authority for its own transport; clients only project returned state.
Begin, part writes, finalization, cancellation and expiry share the owning
store's serialization/transaction boundary. Same-ID metadata or part-content
conflicts fail closed. A lost response resumes the same upload, never another
UUID chosen by a retry loop.

For a durable Blob, the browser records the first begin attempt time in the
same Blob store before sending the request. Memory-only bytes keep that time
only for the current page and cannot claim reload recovery. If the response is
lost, status decides whether the original upload
exists. Only an upgraded owner that explicitly returns `state="absent"` may
accept a repeat begin with the same ID, immutable metadata and original attempt
time. A generic 404, cancelled/consumed/expired receipt, missing original attempt
time, or elapsed original 30-minute window fails closed. Both stores cap a late
first admission at the original attempt deadline; a repeat never extends it.

An existing durable Blob's attempt update looks up only its exact stored key;
it does not re-admit the whole archive. Descriptor, retention timestamp and
captured/desired attempt are checked transactionally, then committed Blob bytes,
hashes and attempt identity are verified before begin. An identical pending write
that already committed is read back without rewriting it. A removed record uses
the existing full capacity/retention admission in the original I/O budget.
Storage failure remains typed browser storage failure, not proof of a network
disconnect; durability, original IDs and explicit-resume rules remain unchanged.
See ADR-0274.
Expired IDs retain a bounded seven-day tombstone so a delayed retry cannot
recreate them after staging cleanup. The client never admits a message during
this recovery; manual resume and reload use the persisted Blob and ID.

`agent-hub-attachment-upload-v1` uses POST begin, GET status/capabilities, PUT
indexed binary part, POST complete and DELETE abandon at
`/api/attachment-upload`. Every part is at most 1 MiB and includes SHA-256.
Status reports exact persisted part indices, sizes and hashes. Finalization
requires all exact parts and byte lengths, verifies the ordered complete SHA-256
with bounded working memory, and atomically publishes the existing attachment
descriptor. No partial file is command-readable. Duplicate completion returns
the same final identity and hash.

A successful begin response is that same authoritative upload receipt. A fresh
upload uses it directly; only an existing or lost attempt needs a status request.
HTTP success headers alone are not a received receipt. An aborted or malformed
JSON body remains unconfirmed and preserves the saved attempt for explicit
resume/status reconciliation. It is not an upload-ID, protocol or checksum
conflict, and cannot authorize a new begin/attempt or accepted message. A decoded
receipt with a different upload ID or protocol still fails the strict identity
check. An unreadable error body retains its actual HTTP refusal without guessing
an absent/expired state.
Local preparation and the initial capabilities/auth request carry the original
upload ID, joined to the message ID when sending starts. A failed local read keeps
its original File and preview in the live draft, alongside successful files in
the batch. Explicit retry retains the ID and repeats only failed preparation;
explicit removal or Task invalidation disposes that preview. This is memory
retention for the current page, not a promise of recovery after closing it.

Admission reserves declared bytes before accepting parts. Defaults are 128 MiB
per file, 256 MiB per authenticated owner's uploads, at most 32 uploads and a
fixed 30-minute lifetime. `AGENT_HUB_ATTACHMENT_MAX_BYTES` and
`AGENT_HUB_ATTACHMENT_USER_MAX_BYTES` configure byte budgets, bounded by 256 MiB
and 512 MiB respectively. Repeats never extend expiry. Pending parts and
receipts have bounded cleanup even without another user upload. The existing
eight-attachment message count remains unchanged.

Stopping a send aborts its preparation transport and restores the same draft;
parts remain available for explicit resume until expiry. Permanent abandon
cannot delete an accepted command's files. Final local files remain under the
existing attachment/history lifetime, not a staging timer. In the Worker,
command linkage and cancellation are transactionally fenced. New-protocol ready
bytes survive terminal command unlink until their original upload expiry, so an
explicit rejected retry may reuse the same upload. An expired transport identity
is never reused or extended. If the original bytes remain available, an explicit
send/resume may persist one fresh transport UUID and original-attempt timestamp
before begin, retaining the logical attachment/Blob and message identities.
An upgraded owner must explicitly report expired state, or absent state after
the old deadline (or for a legacy attempt without a saved timestamp). A generic
404, cancellation, hash conflict or unknown outcome does not authorize renewal.
The new attempt is visible as recovery, resumes its own lost response and can
survive reload only with a verified saved Blob and attempt record. Persistence
failure blocks begin; one invocation cannot loop through fresh attempts.
Without original bytes a preview is insufficient and selection is required.
See ADR-0110. Server receipts and tombstones remain the transport authority.
The browser's prepared uploadId/blobId remains the logical attachment identity;
its separate saved uploadAttemptId is the current protocol UUID and initially
equals uploadId. Receipt uploadId still names the transport UUID. Changing an
attempt does not rewrite the prepared descriptor or local draft recovery
fingerprint. An already frozen message submission retains its original final
attachment paths on unknown retry; renewal never replaces an admitted payload.

## Memory, storage and recovery

Clipboard/file selection prepares the local draft without network negotiation.
Accepted local files show a temporary thumbnail with a preparation label before
hashing and database persistence finish. That preview is not an upload, a durable
draft or a sendable attachment. It follows the same Task and cancellation fence
as preparation; finishing a cancelled operation cannot restore its preview or
attachment. Send and managed reload cannot silently discard a selected file
still being prepared. Hashing and local-save timings contain no file contents.
Its local bounds are eight files, 256 MiB per file and 512 MiB per draft. Before
the first upload, the send path checks every file and the aggregate draft against
negotiated capabilities, including the legacy 20 MiB aggregate limit. A rejected
batch restores the same unsent draft through the existing preparation-cancellation
owner; local preparation never claims upload or message acceptance (ADR-0074).

The browser stores file Blobs and bounded hash/reference metadata rather than
whole-file base64 copies. Durable recovery is granted only after Blob storage
and its exact manifest are verified. The existing composer revision, recovery
epoch and complete-payload fingerprint still gate restoration and same-message
retry. Failed storage remains explicitly non-durable and cannot permit a managed
reload to discard the only usable composition. See UI-001 and ADR-0037.
Local database open, write and committed-record read share a five-second storage
budget. Concurrent opens share one request; late handles are closed after timeout.
Transaction timeout retires only that connection; a later selection opens a new
one without clearing the store or replaying the failed save. Exact committed
readback and successful byte verification establish durability even if the
verification itself finishes after the I/O deadline. Elapsed time alone cannot
reclassify that proven save as failed. Diagnostics distinguish open, scan/write,
committed read and byte verification without file contents.
The committed Blob and manifest are read back and verified before granting
durability. A failed save retains the original in memory for sending and keeps
its structured failure category for diagnostics. It does not add a storage
warning to the composer or a toast. The existing non-durable reload guard remains
in force; silence is not evidence that recovery survived. It never recommends
clearing site data containing other drafts.
The browser Blob store is bounded to 512 MiB and 128 records, with a seven-day
retention limit. Expired bytes cannot assert durable recovery. Memory references
are retained only for staged selections, drafts and unresolved submissions.

Remote-to-local materialization uses the existing chunks-v1 transport: manifests
and chunks remain below 25 KiB. The receiving runtime holds at most one bounded
manifest page and four active part reads, verifies every part, writes to a private
temporary file, verifies final size/hash and atomically publishes without
overwriting an existing different file. A failed attempt drains its started
reads and removes only its private partial. It cannot delete an earlier finalized
file owned by the same command.

Large history-file publication uses authenticated service upload with the same
part owner and a view-only capability. Public upload callers cannot claim that
service mode. The public view streams stored parts rather than buffering the
whole file. Existing message, queue and receipt ownership is unchanged.

## Migration and surface limits

VS Code also carries this protocol over its authenticated desktop pipe when
the optional local Web App is disabled. Each PUT carries at most one 1 MiB
part encoded as base64; it never materializes a whole-file base64 request.
The runtime desktop adapter leases the same AttachmentUploadService instance
and local owner as the HTTP WebView, preserving receipts, mutation ordering,
quotas and upload identity across transports. It releases its lease during
runtime shutdown. Optional external components remain disabled. Upload
preparation does not enter message-command receipts or admission queues.

The whole-body `/api/attachment` and old VS Code bridge remain bounded to 20 MiB
for old clients. They are a rolling-deployment boundary, removable once every
supported client/server advertises upload-v1. Large files never fall back to a
whole-body request. Existing attachment filenames and history remain readable;
there is no data rewrite or automatic message replay.

The chat composer in Browser, the shared Mini App/Android UI and VS Code uses the
negotiated upload protocol. Task-card and bug-report attachment pickers retain
the legacy 20 MiB transport; migrating these independent preparation flows is
outside this change. Native Telegram bot-file intake keeps its upstream getFile limit;
large files must be attached through Hub's web interface. Running a separate
local Telegram Bot API server is outside this change.

Local finalization processes at most one protocol part per read/write buffer,
retaining ordered per-part and final hashes, fsync, atomic publication and the
original receipt. It does not fragment a small multi-part file into dozens of
serialized 64 KiB I/O round trips. Existing origin traces and Server-Timing also
separate owner-queue wait, storage read/open/write/sync/close/rename/publication
and cleanup awaits. These durations include scheduling delay, not just device
work; the per-request owner event-loop maximum is separate and must not be
subtracted as an attribution formula. Incomplete monitor sampling can report
zero. Timings use a finite scalar vocabulary, survive failed operations through
the existing trace owner, and never authorize a receipt or alter an outcome.

Upload diagnostics distinguish client session/auth wait, capabilities, durable
attempt recording, begin/status/part/complete, response parsing and paused
manual-resume time. Client HTTP spans end at response headers: they are not
independent measurements of request-body transit or server execution. Where
available, `Server-Timing` separates server authentication, body read and owner
work (including storage); the remaining network/queue time is not attributed
to a specific hop. Upload/message IDs and bounded durations/status/failure kinds
are allowlisted; file bytes, names, text, URLs, tokens and raw errors are not.
Receipt measurements retain explicit absent/expired/cancelled state, never infer
it from error text. The original logical upload ID and message ID join each
transport uploadAttemptId, including after renewal. Failed upload spans survive a reporting outage in a 24-hour, 256-event browser
ring and retry without affecting upload results. Local runtime traces use
`command-traces.sqlite`; public Worker traces are retained separately in the
authenticated Journal Durable Object for 24 hours, at most 64 upload IDs per
owner and 256 spans per ID. Neither store is message-admission authority.
