# ADR-0083 — Preserve upload identity and failure timing across transport loss

## Status

Proposed for HUB-274; publication requires the reviewed Worker and local runtime
to deploy with the browser assets.

## Context

A screenshot upload could pause after a lost `begin` request. The browser had
already marked the upload started and resumed through status, so an unreceived
begin produced a 404 with no safe way to distinguish it from an expired upload.
Existing aggregate client HTTP traces could not attribute the failed upload
stage, and their batches could disappear while the reporting endpoint was down.
The historical user screenshot does not identify the actual transport or cause.

## Decision

1. Persist the first attempt time before begin for recoverable Blobs; memory-only
   sends cannot claim reload recovery. Only an explicit absent receipt
   from an upgraded owner permits same-ID/same-metadata begin recovery inside
   the original lease. Cancelled, consumed, expired and generic 404 responses
   remain terminal; both local and Worker owners retain bounded expiry evidence.
2. Pair upload-stage start/end traces with the original upload and message IDs.
   Keep a bounded, expiring, content-free browser failure queue across reloads.
   Telemetry failure never changes upload outcome or causes message replay.
3. The local runtime retains its existing SQLite trace owner. The public Worker
   cannot write to that owner; authenticated upload-only spans are stored in its
   Journal Durable Object with exact-ID readback and separate retention bounds.
4. Client spans measure through response headers. Server-Timing measures auth,
   body read and owner work where available. Neither asserts a specific network
   or storage substage from an aggregate duration.

## Consequences

- Browser assets alone cannot enable safe absent-state recovery or Worker trace
  readback. The reviewed Worker and local runtime changes must be rolled out
  together with those assets on their respective transports.
- Old server responses remain fail-closed. This change does not explain the
  particular historical upload failure without a captured per-upload trace.

## Recurring direct-gateway 502 follow-up

The local Hub's Node HTTP owner expires idle connections after five seconds;
the primary Caddy pool is now explicitly two seconds, below that bound. Other
operator-defined upstreams keep their own transport policy. This addresses the
documented stale HTTP/1.1 reuse/reset path without raising timeouts or enabling
proxy retries for mutating requests. A real isolated Caddy/Node TCP-reset fixture
reproduces the old reuse/PUT502 and the fresh-connection/PUT200 result. Its reset
is controlled fault injection; it does not prove that live user failures have
the same cause or establish production latency.

Each HTTP exchange carries a fresh diagnostic request UUID alongside the
existing logical upload, transport-attempt and message IDs. That UUID is not a
new upload/message idempotency identity. The existing trace store receives the
browser span, authenticated origin start/finish and sanitized Caddy error under
that correlation. Caddy parsing is bounded to 64KiB chunks/16KiB records and
admits only the upload route/stage/UUIDs/status/error enum/duration. Raw URLs,
headers, cookies, tokens, file names, hashes and body bytes are not recorded.
Diagnostics cannot delay or change transport outcome. Unauthorized origin
requests do not initialize upload spans; a missing span is not proof of no effect.

Non-JSON proxy failures retain their HTTP status and stage. Begin/chunk/complete
502 remains uncertain and retryable with the retained draft. Explicit resume
reads the same owner's receipt; a committed chunk or completed file is not sent
again. No automatic resend, lease extension, cancellation or message admission is
introduced. Existing expiry renewal rules remain unchanged.

Installed .20 lacks these source changes. Its persistent gateway must receive
the desired config through the existing release owner's verified handoff; merely
overwriting a live Caddyfile or launching another port443 listener is not delivery.
Source validation is not a live configuration/restart or release authorization.

## Configured Worker during gateway handoff

The one-restart delivery sequence exposed a composition boundary: the gateway's
typed handoff refusal rejected the shared transport-startup promise before the
already configured Worker could start. Gateway-only health recovery cannot
resume that cached promise or its skipped services. Actual installation flags
have Worker enabled; absence of a Worker deployment is not a disabled setting.

The existing Mini App lifecycle now defers only that exact gateway refusal while
starting independent configured transports in their original generation. The
Worker's real publication callback chooses its fallback menu when no gateway URL
has been confirmed. Other gateway failures are not swallowed. After independent
startup the exact original handoff error still rejects the shared promise;
neither local readiness, Worker publication nor eventual Caddy health is called
complete transport startup. Repeated same-generation starts do not replay those
services. Closing the lifecycle fences delayed Worker/tunnel menu callbacks.
The gateway configuration refusal, owner process guards and health timer remain
unchanged. This introduces no reset API, retry loop, new writer or second restart.
