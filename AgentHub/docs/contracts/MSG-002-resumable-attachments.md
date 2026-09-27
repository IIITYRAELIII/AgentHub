# MSG-002 — Resumable attachment upload

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

`agent-hub-attachment-upload-v1` uses POST begin, GET status/capabilities, PUT
indexed binary part, POST complete and DELETE abandon at
`/api/attachment-upload`. Every part is at most 1 MiB and includes SHA-256.
Status reports exact persisted part indices, sizes and hashes. Finalization
requires all exact parts and byte lengths, verifies the ordered complete SHA-256
with bounded working memory, and atomically publishes the existing attachment
descriptor. No partial file is command-readable. Duplicate completion returns
the same final identity and hash.

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
explicit rejected retry may reuse the same upload. An expired identity fails
visibly and is never silently substituted.

## Memory, storage and recovery

Clipboard/file selection prepares the local draft without network negotiation.
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
