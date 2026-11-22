# ADR-HUB-496 — Authenticode for the Codex main executable

## Decision

Agent Hub 2.1.17 can refuse an update before stopping the old runtime because
an installed Codex helper such as `rg.exe` has no accepted Authenticode
signature. For automatic selection, only the main `codex.exe` requires an
OpenAI signer. The same rule applies to discovery, cached selection, fallback
and installer preflight.

The existing selector still requires the official install layout, the main
executable identity, the complete local file inventory and native custody.
Hashes describe the observed files and detect changes between verification and
launch. They establish no publisher or origin for the helpers. The required
code-mode host, compatibility canary, installer archive verification and
rollback remain part of their existing flows.

Stored schema-1 bundles validate using the digest of their original manifest.
After validation, equal names, hashes and effective feature identify the same
bundle even when old entries carry helper publisher fields. Normal successful
startup writes the current representation. Legacy digest validation remains
while this state format is supported for upgrades and rollback. Preflight
observation leaves selection state unchanged.

Contracts: UPD-001, RST-001, REL-001, SYS-001.
