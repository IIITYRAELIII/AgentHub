# ADR-0017 — Trusted automatic Codex executable adoption

## Status

Accepted for implementation by HUB-144.

## Context

Agent Hub previously resolved a Codex executable independently on every App
Server spawn and preferred the newest VS Code extension file by modification
time. That made filesystem ordering the de facto update channel, omitted the
official desktop application, and provided no durable active or
last-known-good identity. The lifecycle could not distinguish a newly adopted
binary from a normal restart and therefore could neither canary nor roll back a
bad candidate.

## Decision

Introduce one executable update service at the process/lifecycle boundary. It
discovers only current-user official OpenAI install layouts, canonicalizes each
path, binds Authenticode and bounded `--version` observations with surrounding
SHA-256 checks, and orders trusted identities by parsed version. The service
persists the selected, candidate, last-known-good, canary, and failure state in
one atomically replaced file under the Agent Hub data directory.

The update service selects an executable only at a safe App Server lifecycle
boundary. Active Codex runs make adoption observable but deferred. A new
identity must pass an isolated, bounded canary before selection. Lifecycle
startup success promotes it to last-known-good; startup failure makes one
bounded rollback attempt. Discovery and canary never download binaries and do
not mutate the registered Workspace or Dashboard.

The canary uses a temporary current-user runtime and an Agent Hub-shaped local
MCP server, so it exercises the App Server/MCP bridge without granting access
to production Task data. It creates its own Thread and restarts the candidate
to resume that Thread. Temporary auth material is copied only when needed,
never logged, and removed in a `finally` path.

Configuration has three explicit modes: automatic adoption enabled, automatic
adoption disabled, and an exact version pin. The existing explicit
`codexExecutable` path is a stronger manual operator override and bypasses the
automatic channel; diagnostics label it `manual-override` rather than implying
official discovery trust.

## Update-channel threats and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| A planted `codex.exe` in a lookalike directory | Canonical allowlisted install roots plus valid OpenAI Authenticode signer | A compromised OpenAI signing key or trusted installer is outside Hub's boundary |
| Version spoofing or mtime manipulation | Bounded `--version`, strict parsed version, SHA-256 identity; mtime ignored | A malicious correctly signed binary may still lie about its version |
| File replacement during signature or version inspection | Hash before and after Authenticode, then around bounded version execution; reject every transition | A kernel-level attacker remains outside Hub's boundary |
| File replacement between canary/re-discovery and launch | At the lifecycle launch boundary, re-read durable selection and re-inspect exact path, version, SHA-256, and publisher before allowing `spawn` | Windows cannot provide an immutable executable handle across the final verification-to-spawn instructions |
| Downgrade or wrong prerelease ordering | SemVer comparison including prerelease identifiers and explicit pin policy | OpenAI version strings outside the supported grammar are rejected, not guessed |
| Canary hang, protocol incompatibility, or unexpected cost | Per-operation and total deadlines, isolated Thread/runtime, single attempt per identity | A successful canary cannot prove every production workload |
| Update interrupts an active run | Adoption deferred whenever active/recovering Codex runs exist | A process crash remains governed by normal run recovery |
| Corrupt or split-brain update state | Single owner, atomic replace, schema validation; automatic adoption fails closed while the explicit manual path remains a recovery boundary | Manual edits can require operator repair |
| Rollback loop prevents Hub startup | At most one LKG rollback attempt per activation failure | If both candidate and LKG fail, provider health is failed and diagnostics retain evidence |
| Secrets or local paths leak through diagnostics | Auth is never recorded; diagnostics expose only executable identity and bounded errors | Exact executable paths remain local diagnostic data |

## Consequences

App Server startup gains a bounded check only when a new executable identity is
seen. Ordinary restarts reuse the recorded last-known-good without a canary.
The Hub can adopt a newer already installed official Codex without becoming a
package manager. Operators retain deterministic disable and pin controls and a
readable reason whenever adoption is deferred or rejected.

The removal condition for the legacy mtime resolver is successful migration of
all call sites to the update service. No permanent fallback may continue to
select by mtime afterward.
