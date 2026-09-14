# Canonical command mapping through a recording contour

> Design-stage record: the text below describes the earlier isolated layer.
> These layers are now integrated in HUB-182; current preparation, executed
> full-shell acceptance and remaining exclusions are documented in
> [Recording contour](recording-contour.md). Historical statements about an
> unconditional boot fence or unintegrated callers do not describe current code.

This incremental patch depends on `recording-provider.patch` and
`reference-effects.patch`. It closes the selection/message/queue/provider
coordinate gap for captured, explicitly seeded Thread bindings. It does not open
the production-cohort boot fence or claim full contour parity.

## One durable coordinate system

The captured runtime state, message command ledger, receipt fingerprints and
submitted input remain canonical. The earlier reversible queue-view helper is
not installed as a RuntimeStateStore wrapper. The real queue and recovery owners
continue reading and writing their original canonical objects.

`createContourCommandMapping` reads the existing persistent recording marker.
Its source roots provide typed path mappings; its exact provider/Thread/Stream
bindings validate selected targets. The marker is not a command receipt or a
second queue owner. `RuntimeStateStore.messageCommand(id)` delegates one indexed
point read to the existing ledger; no full-ledger scan or extra database owner is
introduced.

The connected path is:

1. Desktop router composition canonicalizes only `send-message` and `select-task`
   target fields **before** the existing outer command fingerprint is computed.
   The handler and receipt receive the same request. Missing transport fields
   are not injected, and arbitrary message text/annotations are never traversed.
2. Shared TaskIdentityResolver recognizes prepared project aliases and returns
   canonical project paths. Client selection saves canonical bindings. The
   Telegram selection composition uses the same target conversion for explicit
   selection and catalog comparisons.
3. Desktop message preparation resolves actual local attachments first, then
   obtains their canonical paths before generating the document-reference header.
   This avoids rewriting user prose or leaving a prepared filesystem path in a
   generated prompt. Attachment descriptors/IDs remain unchanged.
4. MessageController canonicalizes its resolved target and typed input before
   admission. `messageRequestFingerprint` remains exactly the existing algorithm:
   text, attachment IDs, task references, modes and optional origin. It does not
   contain project paths and is not replaced with a contour-specific hash.
5. If that exact `clientUserMessageId` already has a ledger item, typed execution
   equivalence is checked against its original input. Unchanged text, full
   annotations and equivalent mapped attachment paths recover the exact saved
   input, including original lexical path spelling. Different content or source
   evidence is rejected. Lookup never uses text, timing or order as identity.
6. The existing DeferredInputService, RunCoordinator and RuntimeStateStore persist
   and restore canonical input and occupancy. The literal provider receives that
   canonical input and uses its existing execution mapper exactly once. Provider
   deduplication remains the recording provider's durable command/turn owner.

No field is added to the canonical ledger schema and no canonical fingerprint is
recomputed on load. Root-keyed legacy queue lanes are not remapped or rekeyed by
this mechanism: they retain their original roots. New seeded commands retain the
real Stream/provider/Thread occupancy key.

The patch also completes a missing explicit composition hop from the prior
effect-exclusion patch: `agent-hub-composition` now forwards
`contourExternalEffects` from infrastructure to provider-application composition,
so UsageSync receives the verified policy. No additional external guard is added.

## Executable evidence

Run:

```text
node --test --test-concurrency=1 tests/runtime/contour-mapping-wiring.test.mjs tests/application/task-identity-resolver.test.mjs tests/interfaces/desktop/desktop-message-controller.test.mjs tests/interfaces/desktop/desktop-control-router.test.mjs
```

The new integration uses the real DesktopRouter/MessageController,
ClientTaskSelectionService, TaskIdentityResolver, DeferredInputService,
RunCoordinator, RuntimeStateStore and SQLite message command ledger. It launches
the literal recording backend, checks that durable intake precedes provider
acceptance, persists the started state, closes/reopens both durable owners, then
retries the same command from its operational project path. The outer receipt
bytes and inner message fingerprint remain unchanged; the queue does not revive
the started command and the provider retains exactly one turn. An inner retry
and provider-side recovery retry likewise produce no second effect. Altered text
with the same ID fails.

The outer router receipt in this isolated test uses its supported JSON store;
the canonical message receipt/queue use the actual SQLite command ledger and
runtime writer. The experiment does not substitute a memory ledger. It does not
claim a complete SQLite outer-receipt or whole-Hub restart scenario.

A second test preserves an 80,000-character source annotation while converting
typed attachment aliases, and rejects changed source evidence, foreign Stream
bindings and unknown paths. Ordinary owner tests cover the profile-absent path.
All fixture roots are temporary and removed after owners close. No production
files are read, copied or executed by these tests.

## Remaining acceptance gates

- Catalog/journal/task read-model routing and complete config/selection parity
  still require a prepared production-shaped cohort. This patch validates the
  ingress and saved-selection path, not every historical read or every surface.
- Existing outer transport receipts computed before this adapter against an
  alternate lexical project alias are not rehashed or guessed from their hash.
  A mismatching legacy outer receipt must fail closed. The inner canonical
  message receipt remains intact. A migration that permits those aliases needs
  original transport request evidence, not a new command ID.
- PID ownership, output/cleanup files, media/delivery and interactive Git
  boundaries remain separate unresolved guards. The new work does not invoke
  cleanup on canonical production paths or permit production-data Hub startup.
- Actual process-deadline cohort capture, non-SQLite persistence coherence and
  candidate replacement acceptance have not run on production data.
- `CONTOUR_RECORDING_BOOT_NOT_READY` remains unconditional. Bounded readiness
  identity and compact-snapshot size limits remain documented in the earlier
  acceptance design.

Preserved contracts: MSG-001 command/receipt identity and exact occupancy,
RST-001 durable recovery authority, SYS-002 Workspace/Stream identity and owning
admission, PERF-001 point reads with no new global queue or synchronous full scan.
