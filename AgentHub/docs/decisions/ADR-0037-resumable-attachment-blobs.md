# ADR-0037 — Resumable uploads and Blob-backed composer files

## Status

Accepted for HUB-172.

## Context

The 20 MiB limit bounded whole-file base64 in the composer, binary HTTP requests,
the VS Code bridge and receiving adapters. Raising one constant would retain
several complete copies in memory, break other receiving paths and provide no
resume evidence after an interrupted upload. UI-001 previously specified strict
base64 recovery because base64 was the only supported local byte representation.

## Decision

Add the versioned protocol and ownership boundaries in MSG-002. Keep the legacy
whole-body byte limit independent of the configurable complete-file budget.
Store browser file bytes as Blobs in IndexedDB before granting durable recovery;
the existing composer remains the single owner of draft and retry identity.
An exact verified Blob manifest is an additional byte-proof representation, not
permission to weaken complete-payload fingerprint or revision checks. A storage
failure retains explicit in-memory-only recovery and the reload fence.

Separate stopping preparation from permanent upload abandonment. A transport
abort never claims that a command already admitted by Hub was cancelled.
Final local files are not staging garbage; a later attachment failure must not
delete a file already used by the same accepted command.

## Consequences

Upload progress and explicit resume can work across transport loss without
reallocating a message or upload identity. Memory is bounded by parts while
durable byte capacity is separately bounded. Native Telegram Bot API limitations
remain explicit; this change does not install another Telegram service. Old
base64 drafts and clients continue through the documented bounded migration path.
