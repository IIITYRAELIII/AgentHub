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
