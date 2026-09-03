# UPD-001 — Trusted Codex executable update channel

## Identity and owner

`CodexExecutableUpdateService` is the only owner of the Codex executable
selection used by the Hub-owned App Server. Its durable record is
`data/codex-executable-state.json`. The App Server lifecycle consumes the
selected executable and reports startup success or failure; it never discovers
or silently changes versions itself.

An executable identity is the tuple `canonicalPath + version + sha256 +
publisher`. A path or a version alone is not an executable identity.

## Trust boundary

- Automatic discovery is Windows-only and enumerates only the installed binary
  layouts of the official OpenAI Codex desktop application and official OpenAI
  VS Code extensions for the current user.
- Every automatic candidate must have a valid Authenticode signature whose
  signer subject is OpenAI, must remain inside its canonical allowed install
  root, must report a parseable Codex version through a bounded `--version`
  invocation, and must have a SHA-256 digest computed from the same file.
- Authenticode and version results are bound to the accepted bytes by hashing
  immediately before and after signature verification, then hashing again
  after the bounded version process. Any transition between those observations
  rejects the identity.
- Selection compares parsed versions, including prerelease identifiers; file
  or directory modification time is never update authority.
- The update channel never downloads, installs, copies, patches, or executes an
  untrusted candidate. A configured manual executable is an explicit operator
  override outside automatic discovery and is diagnosed as such.

## Activation invariants

- Automatic adoption is opt-out and can be disabled. An explicit version pin
  prevents adoption of every other discovered version. The existing explicit
  executable path remains the strongest manual pin.
- A new executable is not active until a bounded isolated compatibility canary
  succeeds. The canary covers App Server initialize/health, new Thread,
  restart/resume of that Thread, ordinary turn, isolated Agent Hub-shaped MCP
  read, cancel, and a successful following turn. Canary runtime state and auth
  copies are removed after the result is recorded. Transport RPC acknowledgement,
  asynchronous model-turn completion, cancellation, and the whole scenario use
  separate bounded deadlines; an RPC deadline is never reused as a model SLA.
  Because App Server mediates MCP permission through a client-side elicitation,
  the canary answers only a safely auto-answerable request bound to its exact
  isolated `agent_hub` server, Thread, and MCP turn. Every other inbound request
  fails the canary closed.
  Cancellation is sent only after the accepted turn emits its exact
  `turn/started` lifecycle event; RPC acceptance alone is not evidence that a
  turn is active.
  Restart/resume begins only after the previous child emits process `close`, so
  its isolated SQLite state cannot overlap the replacement App Server.
- Immediately before every App Server process spawn, the lifecycle re-reads the
  durable selected identity and re-inspects the installed executable. The exact
  canonical path, version, SHA-256, and publisher must still match. A mismatch
  cannot reach `spawn`; it uses the same bounded verified last-known-good
  rollback when available and otherwise fails closed.
- A candidate is never activated while a Codex run is active or while active
  run recovery is pending. Discovery may report the candidate, but activation
  remains `deferred-active-runs` until the next safe lifecycle boundary.
- Successful startup atomically advances both `active` and `lastKnownGood`.
  Canary or startup failure keeps or restores the previous last-known-good
  identity. Unknown or missing last-known-good state is reported and never
  guessed from modification time.
- Repeated discovery of the same executable identity is idempotent. A failed
  identity is not retried until its bytes change.
- Rollback is bounded to one last-known-good attempt per failed activation; a
  rollback loop cannot keep the Hub startup pending indefinitely.

## Diagnostics

Runtime health exposes the configured policy, selected active identity,
last-known-good identity, highest trusted candidate, canary result, deferred or
blocked reason, and last error. It never exposes auth material or executable
contents.

Canary failure also leaves a bounded machine-readable content-free protocol
timeline and redacted stderr tail under
`data/codex-executable-canary/last-failure.json`. It records
phase, method/turn identifiers, statuses, candidate identity, and the bounded
error only; prompts, the isolated MCP capability, auth material, and response
contents are excluded. The isolated run directory is still always removed.

## Readiness evidence

Executable tests must cover official Desktop and VS Code discovery, semantic
version ordering, invalid signatures and spoofed versions, pin/disable policy,
idempotent restart, active-run deferral, canary timeout/failure, successful
activation, startup rollback, diagnostics, and secret-free state.
