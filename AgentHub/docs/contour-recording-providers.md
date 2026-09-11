# Literal recording providers: partial contour implementation

> Design-stage record: the text below describes the earlier isolated layer.
> These layers are now integrated in HUB-182; current preparation, executed
> full-shell acceptance and remaining exclusions are documented in
> [Recording contour](recording-contour.md). Historical statements about an
> unconditional boot fence or unintegrated callers do not describe current code.

These adapters replace provider effects with isolated durable recordings. They do not interpret prompt markers, execute tools, read attachments, call the network or start child processes. The adapter CLI itself is the process launched by the existing provider boundary. Synthetic outcomes are explicit scenario operations, never instructions embedded in production messages.

This implementation is **not a bootable production-data contour**. Config parsing rejects `testContourRecording` with `CONTOUR_RECORDING_BOOT_NOT_READY`. Its error lists the remaining owner boundaries. A manifest claiming `bootable:true` cannot override that fence. Ordinary configuration without this profile keeps the existing provider path.

## Implemented connections

- `RecordingContourProvider` stores commands and turns in a separate recording-provider SQLite database. Receipt persistence precedes acknowledgement. A repeated exact command returns its existing turn; changed content or target under the same identity fails. Terminal states are absorbing. This database models the external provider; it does not replace Hub's canonical command ledger or terminal store.
- The Codex stdio CLI connects to the existing `CodexAppServerTransport`. It supports initialize, seeded Thread reads/resume/list, turn start/interrupt and explicit scenario completion. Unknown operations fail. Restart reads the same recorded command identity. It deliberately does not infer Thread IDs or seed sessions from prompt text.
- Claude's launcher has an explicit optional recording branch. It passes original `clientUserMessageId` and the launcher-assigned `run.turnId` through a hashed request file. Input and annotations remain complete. An isolated CLI compares stdin with that exact binding and records the original structured input. The branch bypasses installed Claude discovery and original session reads, uses an isolated working directory and registers only remapped paths for completion cleanup. Normal launch behavior is unchanged when the profile is absent.
- The operational mapper creates a separate execution view. It remaps typed project and local-attachment roots, matches whole path components, rejects unknown roots, relative paths, alternate streams and unsupported input types. Historical text, quotes, source locators, Stream/Thread IDs and command IDs are not changed. It does not rewrite canonical ledger fingerprints or occupancy keys.

## Focused checks

```powershell
node --test tests/runtime/contour-operational-recording.test.mjs tests/runtime/contour-recording-transport.test.mjs tests/runtime/contour-recording-claude-launch.test.mjs tests/runtime/contour-recording-profile.test.mjs
```

Tests use temporary roots and hidden local provider processes. They cover literal `[child:]`, `[hold:]`, `[fail]`, rollout and MCP markers; original annotation retention; restart/idempotency; real Codex transport events; the actual Claude launcher; cleanup path isolation; and rejection of premature whole-contour boot. They do not launch Hub or access production data.

## Required work before whole-cohort acceptance

| Boundary | Required treatment |
| --- | --- |
| Catalog/selection/registered Workspace directories | Implement one operational projection consistent with provider catalog matching. Preserve canonical ledger fingerprints and occupancy. `config.projectRoot` alone does not govern these paths. |
| Active process ownership and temporary output paths | Reconcile production PIDs as unavailable in the contour; never kill/attach the original process. Remap runtime output/cleanup paths, retain durable terminal and command identities. |
| Git/release/task reconciliation | Exclude external background Git at the existing startup owners, recording intended Workspace targets without invoking Git. This includes registered `workingDirectory` values from the copied catalog. Interactive release operations must fail explicitly in this profile. |
| Usage/work-log sync | Exclude automatic remote synchronization and prevent manual calls from constructing a real client. Do not import production enrollment/device credentials. Keep local usage projections where safe. |
| Media and delivery | Separate accepted internal queue/terminal recovery from excluded image/voice/speech jobs and Telegram/Worker delivery. Use recording or loopback adapters at send/ACK owners; disabling a timer is insufficient. |
| Codex provider operations | Add bounded pagination, seeded historical turns, steering with its own command identity, and explicit account/model/maintenance behavior needed by startup. Unsupported methods currently fail instead of returning false success. |
| Claude lifecycle | Add recording session discovery/recovery and steering with an exact new command binding. Current CLI supports a bound launch and explicit scenario completion only. |
| Snapshot capture | Place backup and hashing inside a process-owned deadline. On timeout terminate the worker and verify exit so retained SQLite read transactions release; `Promise.race` around a continuing backup is insufficient. |
| Readiness | Use the existing compact snapshot/protocol-4 call for candidate checks; the approximately 3.49 MB compact snapshot is still size-limited. A bounded health/identity-only response remains separate work. |

Only after these owners are wired and a prepared cohort is validated may the boot fence be removed. Then run core accepted-command FIFO, interrupted admission, exact terminal recovery and outbox projection scenarios on the same immutable release bytes. Report each checked scenario and each excluded external/background feature separately. Do not claim full parity from process readiness.
