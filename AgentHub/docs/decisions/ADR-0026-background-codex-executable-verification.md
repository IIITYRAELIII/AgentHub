# ADR-0026 — Background Codex verification and recorded startup identity

## Status

Accepted by the user's 2026-09-08 request to verify changed executables in the
background and start the already verified executable. Supersedes ADR-0017's
repeated Authenticode/version inspection at ordinary process launch.

## Context

The measured Hub startup spent 30.766 seconds selecting verified executables
and another 7.704 seconds re-inspecting the selection. Both paths repeated
signature, version and multiple content reads for unchanged installed files.
The exact cause of the additional in-process latency is not yet established.

## Decision

Keep `CodexExecutableUpdateService` as the only state owner. Persist verified
identities and a background-prepared candidate alongside last-known-good.
Ordinary startup reads this state without discovering installed versions.
Before spawn, check the selected canonical official layout and compare one
fresh SHA-256 against the recorded identity. Never use mtime or size as trust.
Missing or changed bytes fail closed, with the existing bounded LKG rollback.

Check installations in a single-flight background operation every minute after
startup settles. Unchanged path/source/hash identities reuse signature and
version evidence; changed bytes receive the original full verification. Only
an idle canary can prepare a new candidate. Preparation never restarts a
provider, changes the active selection or interrupts a user turn. Activation
waits for the next safe provider start. Background errors are independent of
working-provider health. Stop fences late writes; atomic state writes remain
ordered even when a startup and a background check overlap.

Initial setup or a newly requested pin with no matching verified identity must
still verify synchronously: there is no trusted executable available to start.
Existing schema-v1 last-known-good records seed the trust cache on read, without
rewriting their identity or replaying a canary. Optional new fields make this
an additive migration; old records need no separate data migration.

## Consequences and limits

This removes repeated signature subprocesses and version probes from normal
startup, not all startup I/O. One content read remains necessary to distinguish
an unchanged file from replacement at the same path. RuntimeHost verification
of Hub's own release is separate and unchanged.

Signature revocation or trust-store policy changes are not rechecked for
unchanged bytes. Verification evidence, like the existing selection state, is
trusted local-user state; this is not protection against an attacker who can
rewrite both that state and executable files. Canonical layout checks and a
fresh content hash retain detection of executable-only replacement. The final
hash-to-spawn race remains, as before; there is no immutable Windows execution
handle in this implementation.

Behavioral evidence must cover unchanged cold startup without discovery,
changed bytes and redirected paths, isolated background failure, single-flight
preparation, active-run deferral, pin/disable, and one bounded LKG rollback.
