# UPD-001 — Trusted Codex executable update channel

## Identity and owner

`CodexExecutableUpdateService` is the only owner of the Codex executable
selection used by the Hub-owned App Server. Its durable record is
`data/codex-executable-state.json`. The App Server lifecycle consumes the
selected executable and reports startup success or failure; it never discovers
or silently changes versions itself.

An executable identity is the tuple `canonicalPath + version + sha256 +
publisher`. A path or a version alone is not an executable identity.

The selected Windows identity additionally binds a content-hashed plain-file
bundle manifest and the effective `code_mode_host` feature. Same-version bytes
in a different official directory are a different identity. Enabled code-mode
requires its own helper; MCP read success alone does not establish shell/tool
availability. See ADR-0138.

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
  read, one real safe shell execution with an exact nonce/Thread/turn/item and
  exit-zero proof, cancel, and a successful following turn. Canary runtime state and auth
  copies are removed after the result is recorded. Transport RPC acknowledgement,
  asynchronous model-turn completion, cancellation, and the whole scenario use
  separate bounded deadlines; an RPC deadline is never reused as a model SLA.
  Because App Server mediates MCP permission through a client-side elicitation,
  the canary answers only a safely auto-answerable request bound to its exact
  isolated `agent_hub` server, Thread, and MCP turn. The synthetic safe-tool turn
  also permits exactly one command-only approval after its exact accepted turn
  and observed command item are bound: the isolated cwd and local environment
  must execute only the generated literal `Write-Output` nonce through System32
  Windows PowerShell or valid Microsoft-signed PowerShell 7 at its fixed Program
  Files path. Remote environments and other shells are refused.
  A request arriving before the turn RPC reply waits for that same reply; it
  never supplies its own turn authority. The response is `accept` for this item,
  never session approval or a policy amendment. The deterministic prompt states
  that same command. Missing/foreign identity, changed cwd/command, stdin/network
  approval, another item or a repeated request fails closed. Every other inbound
  request fails the canary closed.
  The MCP capability is carried in the middle of a long application context,
  not a short token-only entry. Hub transmits a complete ordered instruction
  snapshot in UTF-8-bounded entries (less than 3000 bytes each), refreshed for
  each launch and reused unchanged by retries. The snapshot supersedes prior
  Hub instructions, including sections removed from the current configuration.
  This protects each turn start, including the next turn after compaction.
  Provider-internal compaction during an active turn can still remove application
  context before the following turn; this is a known provider boundary, not
  evidence that the rules remain present throughout that active turn.
  Cancellation is sent only after the accepted turn emits its exact
  `turn/started` lifecycle event; RPC acceptance alone is not evidence that a
  turn is active.
  Restart/resume begins only after the previous child emits process `close`, so
  its isolated SQLite state cannot overlap the replacement App Server.
- An ordinary startup freshly verifies the persisted last-known-good or a
  previously background-prepared candidate, including its complete bundle and
  effective features. Unchanged bytes reuse recorded publisher/version trust.
  Missing main/helper files are not usable recorded identities: existing
  official discovery and canary may select a trusted replacement. Unknown trust
  failures still refuse. A legacy main-only record is enriched once; an enabled
  code-mode bundle without exact safe-tool canary evidence must pass that
  strengthened check once before use. This migration ends when all retained
  identities carry their bundle and exact safe-tool proof.
- Before spawn the selected bundle is held through read-only native file and
  directory handles that forbid writes/deletion/rename, validate canonical plain
  paths, and hash the held files. Every binary member retains OpenAI signature
  policy. The lifecycle re-reads exact durable selection and proves custody is
  still live immediately before spawn. Custody lasts until that exact owned App
  Server's process `close`, including initialize-to-first-tool. Release frees the
  old bundle for the external updater. No files are copied into another bundle,
  patched, mixed or registered separately. A pre-spawn disappearance uses the
  same single retry decision; no tool/turn/command effect is replayed.
- A single-flight background check runs on a one-minute cadence after initial
  startup settles, even if provider startup failed. It discovers installed
  versions, reuses trust for unchanged bytes and canaries a new identity only
  while no Codex run is active. A passed identity is persisted as `prepared`,
  distinct from the actually initialized active identity. The existing lifecycle
  can activate it automatically at an idle provider boundary: no live Codex run,
  pending RPC, queued RPC or stopping/restarting owner. A synchronous provider
  RPC fence retains new requests and their original identities through healthy
  initialize; selected Thread restoration uses the existing resume owner and
  never creates a replacement Thread in this idle update. Background
  failure never replaces the active/selected identity or degrades a working
  provider. Shutdown disables scheduling and fences late background results.
- A healthy transport is never replaced while a Codex run is active or requires
  recovery. A definitively unavailable recorded bundle with no running provider
  child may be replaced through the same verified owner while saved run lanes
  remain occupied; canonical recovery then inspects those exact runs. Missing
  binaries never authorize clearing custody, inventing terminal state or replaying
  input. Discovery alone remains deferred while a healthy provider is busy.
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
Successful real initialize reconciles its failed provider startup operation and
capability at the canonical startup coordinator, without replaying completed
startup work. Running alone is insufficient. A separate failed recovery remains
failed until that exact canonical recovery succeeds; other failures are retained.
The startup screen exposes current backend capability errors separately from
completed historical startup stages instead of replacing them with a generic
unfinished-stage message. It obtains details through the existing authenticated
runtime-health control; the public health probe still omits provider/local
errors and remains the unauthenticated fallback summary.

Canary failure also leaves a bounded machine-readable content-free protocol
timeline and stderr observation counters under
`data/codex-executable-canary/last-failure.json`. It records
only allowlisted phases, protocol methods, validated Thread/turn identifiers,
statuses, exit code/signal, candidate identity, failure class/code, timestamps,
bounded counts and fixed safe-command scope/refusal flags. Arbitrary child stderr, RPC errors, prompts, the isolated
MCP capability, auth material, and response contents are never retained in the
file, attached evidence, thrown error, or canary-owned logs. The isolated run
directory is still always removed.

## Readiness evidence

Executable tests must cover official Desktop and VS Code discovery, semantic
version ordering, invalid signatures and spoofed versions, pin/disable policy,
idempotent restart, active-run deferral, canary timeout/failure, successful
activation, startup rollback, diagnostics, and secret-free state.
