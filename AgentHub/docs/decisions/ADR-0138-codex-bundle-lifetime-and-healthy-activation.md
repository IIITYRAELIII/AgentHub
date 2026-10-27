# ADR-0138 — Codex bundle lifetime and healthy automatic activation

Status: accepted implementation proposal for HUB-348, subject to exact review.

## Problem

An external Codex update can remove a persisted executable or a tool helper
while the main App Server still initializes. Main version equality and MCP read
success do not establish helper availability. A prepared replacement was not an
activated transport, and a later successful automatic initialize did not settle
the startup coordinator's previous provider failure.

## Decision

Extend the existing executable identity/state owner with the exact plain-file
bundle manifest, signature/hash verification and effective code-mode feature.
Require one actual safe shell execution in its isolated compatibility canary,
with original Thread/turn/item and literal nonce, independently of MCP read.
Legacy main-only records need this bounded one-time migration proof.

Before selection is published, the Windows custody adapter pins every verified
file and its path chain inside the official installation root with noninherited
read-only handles denying writes/deletion. The existing lifecycle binds those
handles to its exact App Server child until process close. No bundle copying,
mixing, binary patch, new registry or external updater ownership is introduced.
An external updater can install a sibling directory; retirement of the selected
directory waits until the old process closes. This is not a claim about opaque
updaters that kill processes or otherwise bypass ordinary Windows sharing.

Freshly missing recorded files use the existing official discovery/canary and
single bounded startup retry. Unverified trust, manual override, disabled
automatic adoption and exact version pin retain their established authority.
A healthy busy provider cannot be cut over. The existing background owner may
request automatic idle activation through a provider-local RPC fence; original
new commands wait once and are never replayed. If the provider child is absent
and its recorded bundle is definitively unavailable, saved runs retain their
exact lanes while the normal recovery owner reconnects using the verified
replacement. No timeout or missing helper implies terminal state.

Only real initialize success informs the startup coordinator. It settles the
matching provider failure, keeps unrelated stage failures, and schedules optional
metadata at most once. Actual canonical run recovery can settle only the same
failed startup recovery observation. The UI shows current capability failure
details without rewriting completed startup history.

### Official command approval and authenticated startup errors

Real official App Server validation exposed a normal command approval request
that the MCP-only canary handler rejected. The synthetic prompt now specifies
the literal `Write-Output` nonce body. Its one approval is bound to the isolated
Thread, accepted turn, observed command item and exact project cwd. Only Windows
PowerShell from System32 or Microsoft-signed PowerShell 7 at its fixed Program
Files location can wrap that body. The response is item-local `accept`; it never
grants a session, policy amendment, stdin or network approval. An early request
waits for the same pending turn/start response, without repeating the command.
Foreign, late, duplicate or changed requests fail closed. Official bundle
validation accompanies fixture race and negative coverage.

The public `/health` probe deliberately redacts provider errors. Startup UI
reads the existing authenticated `runtime-health` control through the existing
client transport, falling back to the public summary when authentication is
unavailable. This preserves the public redaction boundary and the current poll
cadence; no second readiness owner, diagnostic route or timer is introduced.

## Validation and limits

Focused tests cover actual file disappearance, missing helper, same-version new
hash, prepared fallback, tamper/pin/disabled refusal, native write/delete/rename
denial after initialize, one safe tool effect, idle/RPC fences, loss recovery,
startup readiness and concrete UI errors. Synthetic executables and trust ports
are explicitly fixtures; real selected Codex tool execution and ordinary health
after the compatible runtime delivery remain S2 acceptance, not source proof.

Contracts: UPD-001 (refined activation and migration boundary), RST-001, TURN-001,
MCP-001, SYS-002, UI-001 (existing authority and projection invariants preserved).
