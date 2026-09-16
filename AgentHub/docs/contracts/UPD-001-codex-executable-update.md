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
- Those expensive observations are retained by the executable owner for that
  exact canonical path, source and SHA-256. Unchanged bytes reuse the recorded
  OpenAI signer and version, including after a Hub restart; a path, size or
  modification timestamp alone never permits reuse. Signature revocation is
  not re-evaluated for unchanged bytes (ADR-0026).
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
- An ordinary startup selects the persisted last-known-good or a previously
  background-prepared candidate. It does not discover all installed versions,
  invoke Authenticode, run `--version`, or execute a canary. Only initial setup
  without a usable recorded identity (including a new unmatched explicit pin)
  performs blocking discovery and compatibility checks.
- Immediately before every App Server process spawn, the lifecycle re-reads the
  durable selected identity, validates the canonical official install layout,
  and hashes only the selected file once. These bytes must still match the
  recorded version and publisher identity. A mismatch
  cannot reach `spawn`; it uses the same bounded verified last-known-good
  rollback when available and otherwise fails closed.
- A single-flight background check runs on a one-minute cadence after initial
  startup settles, even if provider startup failed. It discovers installed
  versions, reuses trust for unchanged bytes and canaries a new identity only
  while no Codex run is active. A passed identity is persisted as `prepared`,
  not activated; it is considered at the next safe provider start. Background
  failure never replaces the active/selected identity or degrades a working
  provider. Shutdown disables scheduling and fences late background results.
- A candidate is never activated while a Codex run is active or while active
  run recovery is pending. Discovery may report the candidate, but activation
  remains `deferred-active-runs` until the next safe lifecycle boundary.
- Successful startup atomically advances both `active` and `lastKnownGood`.
  State writes flush the unique temporary file before renaming it over the
  canonical record. A write or flush failure rejects selection and preserves
  the previous record. Atomic rename alone does not guarantee data durability
  after power loss. Corrupt state still fails closed; operator recovery must
  preserve the damaged record and repeat normal trust and compatibility checks.
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
Background progress/failure and the prepared identity are separate diagnostics;
they do not masquerade as a provider initialization failure.

Canary failure also leaves a bounded machine-readable content-free protocol
timeline and stderr observation counters under
`data/codex-executable-canary/last-failure.json`. It records
only allowlisted phases, protocol methods, validated Thread/turn identifiers,
statuses, exit code/signal, candidate identity, failure class/code, timestamps,
and bounded counts. Arbitrary child stderr, RPC errors, prompts, the isolated
MCP capability, auth material, and response contents are never retained in the
file, attached evidence, thrown error, or canary-owned logs. The isolated run
directory is still always removed.

## Readiness evidence

Executable tests must cover official Desktop and VS Code discovery, semantic
version ordering, invalid signatures and spoofed versions, pin/disable policy,
idempotent restart, active-run deferral, canary timeout/failure, successful
activation, startup rollback, diagnostics, and secret-free state.
