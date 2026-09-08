# ADR-0023 — Separate attachment manifest namespace

## Status

Accepted for HUB-166.

## Context

The Worker stored attachment manifests as `control:attachment:<id>` and binary
chunks as `control:attachment-chunk:<id>:<index>`. Cleanup listed the former
prefix, which also matched every chunk key. Opening or uploading one Telegram
attachment therefore materialized all retained attachment bytes inside the
Durable Object transaction before it could publish the requested file. The
production command trace showed repeated full-image publications reaching the
Hub and then timing out at sixty seconds without returning a descriptor.

The client-side authenticated Blob viewer cannot repair this boundary: without
the descriptor there is no owner-bound URL to fetch.

## Decision

New manifests use the disjoint `control:attachment-manifest:<id>` namespace.
Chunks keep `control:attachment-chunk:<id>:<index>`. Quota and expiry cleanup
enumerate only the manifest namespace, whose per-user count is already bounded.

Exact reads retain a compatibility fallback for legacy
`control:attachment:<id>` manifests. They never enumerate that legacy prefix;
an accessed expired legacy record and its exact chunks are removed together.
Deletion removes both possible manifest keys, so a legacy record cannot outlive
successful exact cleanup.

Exact mutation paths resolve both possible keys before acting. An expired legacy
record is deleted before an upload can create a replacement and cannot be linked
to or revived by a command. A live legacy record is promoted by writing the same
manifest to the new namespace and deleting the old key before upload replay,
command linkage or result cleanup continues. The promotion and the surrounding
mutation share one Durable Object storage transaction; a failed write or delete
rolls the whole operation back, so there is no interval with lost or competing
authority. If both keys already exist for one ID, the operation fails closed
instead of guessing which record owns the shared chunks.

## Consequences

Publishing a user-uploaded or generated image no longer scales with unrelated
stored image bytes. The returned opaque descriptor remains bound to the same
Telegram user and expiry; the browser still performs one authenticated fetch
and renders one transient Blob URL. Existing unexpired capabilities continue
to resolve by exact ID. A live legacy capability is migrated only when its exact
identity is mutated; expired or inaccessible legacy garbage is never revived or
pulled into an active request merely for migration.
