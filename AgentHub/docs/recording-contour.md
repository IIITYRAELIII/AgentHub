# Recording contour and persistence recovery

The integrated recording profile runs the real Hub shell, SQLite owners,
canonical message admission, queue, terminal recovery and read projection with
local recording providers. It never interprets prompt text as scenario commands.
This is separate from the ordinary fake model that answers every turn immediately.

## Prepare an owned cohort

Use `captureSqliteCohortInProcess` with explicit absolute source/output paths and
`includeQueueFiles:true`. Its hidden child owns all read pins, copies and hashing
under one hard deadline. See [capture semantics](sqlite-cohort-capture.md).
An unchanged SQLite read window and unchanged JSON sidecars do not establish a
cross-store business transaction or flush pending owner writes.

Pass the completed `captureManifestFile`, a disjoint `outputDirectory`, explicit
`sourceConfig:{projectRoot,projects}` and known `attachmentRoots` to
`prepareRecordingContourCohort`. It creates a fresh `prepared-*` root, verifies
the copied bytes against the raw SHA256, preserves raw evidence, and retains:

- `data/journal.sqlite`, `runtime.sqlite`, `message-command-ledger.sqlite`;
- exact delivery/background JSON records and explicit absent-directory evidence;
- original Workspace/Stream/provider/Thread/command IDs and receipts;
- canonical journal/message/annotation bytes and persisted queue coordinates.

Only typed catalog project fields are mapped into owned execution directories.
The recording marker seeds canonical Thread bindings; project configuration
retains the configured project list rather than collapsing it through an
environment override. No source config credentials are copied. Attachment roots
declare path equivalence only: this stage does not copy attachment bodies.

The resulting `contour-preparation.json` remains `bootable:false`: it is an
evidence document, not an instruction to launch a process. The implemented
profile accepts only phase `prepared`, exact marker/config hashes, the three
owned databases and the isolated runtime/data-root agreement. A standalone
provider marker, modified projects or partial capture still fails with
`CONTOUR_RECORDING_BOOT_NOT_READY`.

## Runtime boundaries

### Adopt into the existing rolling contour

After preparing and independently accepting a pristine cohort, the explicit
`node test-contour.mjs adopt-recording --prepared-root <absolute-prepared-root>`
command adopts it into the existing installed canonical Test Contour root.
`--root` names that existing root when it is nondefault. This command performs a
real contour cutover and must not be used for a read-only review. It never
publishes production. The programmatic boundary is `adoptRecordingTestContour`.

Adoption holds the same root operation lease as refresh and requires the existing
contour marker. It stages copies of `data`, `recording` and the preparation
manifest below `cohort-adoptions/<id>`. Only catalog operational project fields,
owned recording-root fields and dependent hashes are rebased. Canonical records,
raw capture and the supplied prepared root are unchanged. A cohort with recording
execution files is rejected: this migration consumes preparation, not a running
or previously exercised provider.

The candidate is prepared from `dev`, and its manager must advertise the recording
cohort capability before the old runtime stops. Recording launches use the
manager entry from the candidate source, not a possibly old caller's CLI. The
canonical root, marker and operation lock never move. After confirmed stop,
component renames retain the complete old data directory including SQLite
sidecars. Old config, current/source pointers and runtime state are retained too.
The candidate pointer is still published only by normal exact readiness.

`test-contour-adoption.json` journals cutover under the existing operation. A
crash during stop/component replacement is rolled back by the next lease owner
after process absence. Before stopping or rolling back, recovery must match the
adoption operation ID and target root/contour to the authoritative operation
journal and current contour marker. A later independent operation, including one
completed by an older installed manager, fails closed without stopping its
processes or renaming its data. Failure rollback also retains the exact operation
owner check. Candidate bytes are displaced into retained evidence,
never deleted. A ready candidate whose adoption receipt was interrupted is
reconciled against the exact refresh operation and live readiness; its subsequent
writes survive. If launch occurred but readiness cannot be proved, both versions
are preserved and the next start fails with a manual-reconciliation error.
There is deliberately no automatic rollback of an ambiguously exercised cohort.

The synthetic refresh test below now performs initial adoption into a legacy
canonical root and then replacement with a second distinct release. It verifies
the old backup, original prepared/raw hashes, pending identities and recovery of
ready-before-receipt. Unit tests interrupt every component replacement checkpoint
and the stop boundary. No user's installed contour has been adopted by these
tests; live adoption and Windows artifact acceptance remain separate evidence.

The existing installer can consume `recordingSourceConfig` for that prepared
root; `serveTestContour` and candidate launch read its immutable descriptor.
Startup uses allowlisted OS environment values and fresh owned homes. The config
loader fixes literal provider executable paths and disables executable updates
and account polling. Remote transports and source credentials are rejected;
local Mini App and synthetic loopback Telegram remain available.

Canonical runtime queues are not cleared or rewritten. Typed input and cleanup
paths map at the provider/file boundaries. Captured live Claude processes and
stdout/stderr are excluded from recovery authority; existing interrupted recovery
records that exclusion rather than replaying the prompt or inventing completion.
Only locally started recording processes carry the provenance needed for stop
and output access. See [runtime ownership](contour-runtime-effects.md).

Captured Codex audit pending turns and historical queues remain evidence.
Audit reports excluded counts without scanning their source rollout paths;
common rollout readers and attachment imports enforce the same boundary before
file access. Local RPC terminal recovery still runs. See
[rollout exclusion](contour-rollout-boundary.md).

Background media jobs remain inert with original attempts and payloads. Delivery
uses durable local recording receipts under the original deliveryId and
idempotencyKey; a lost transport ACK does not repeat the effect. Recording a media
delivery does not read the production media file. See
[media/delivery boundaries](contour-media-delivery.md).

Git reconciliation, diff capture, usage synchronization and exchange-rate fetch
are explicitly excluded at their owners. Interactive Task/Release Git rejects
before Git execution, leases and Task CAS; source references remain unchanged.
Exclusion is not remote success. The
legacy `clone-data` path refuses a prepared recording root before stop/reset;
it must not destroy the cohort to produce an apparently successful clone.
Ordinary runtime refresh retains the prepared data and uses the same exact
candidate-readiness and operation-lease rules as the existing contour.
Release-candidate smoke verifies the shell, authentication and navigation in a
recording contour without changing its provider model or sending an agent prompt;
the result reports that agent probe as explicitly skipped. Ordinary fake contours
retain the complete agent probe and journal confirmation.

## Windows artifact acceptance with recording data

`test-contour.mjs accept-release --artifact <candidate> --previous-artifact <previous>
--output-root <isolated-parent> --recording-input <input.json>` consumes existing
full Windows artifacts and creates a fresh prepared root. The explicit JSON
input contains `captureManifestFile`, `sourceConfig:{projectRoot,projects}` and
optional `attachmentRoots`, as for the preparation API above. It never copies
the live rolling contour or mutates either artifact. The candidate launcher must
advertise `recordingProfile:1` in its manifest-covered acceptance capability.

The v2 launch marker binds four hashes: recording provider, preparation manifest,
project descriptor and persistent config. Windows Host validates them on every
independent launch, fixes literal-provider identity and isolated homes, and
rejects links or partial profiles. The close fence still closes the owned Job
after config corruption. Legacy synthetic v1 acceptance remains unchanged.
The recording Host reconstructs the OS utility search path from the Windows
system known folder and its WindowsPowerShell directory, after checking both
directories. It never inherits tool directories from the caller's PATH. This
keeps the normal Windows ACL and process owners available without admitting
ambient provider tools or disabling access protection.

The harness reads a captured selected Stream/Thread; it sends no `/new` and no
user input. It requests replacement once and reconciles exact release/PID
readiness. Active work may keep the normal restart barrier waiting; this is
retained as incomplete/failed acceptance evidence, never silently drained or
counted as success. Queue/delivery parity and browser usability remain separate
checks. Executable Host and preparation tests establish these boundaries;
only an actual artifact run can establish Windows replacement success.

## Executed synthetic acceptance

`tests/e2e/agent-hub-server.recording-contour.e2e.test.mjs` builds data through
the actual persistence owners, captures and prepares it, starts the whole shell
and checks compact protocol 4. It covers paused queue preservation across
restart and a started command whose exact recording terminal is recovered by the
normal terminal audit after process replacement. IDs/fingerprint remain equal,
the provider has one command, final/user messages occur once, and raw hashes
remain unchanged. Each full-shell scenario has a 25-second bound.

```sh
node --test tests/e2e/agent-hub-server.recording-contour.e2e.test.mjs
```

This is real shell recovery evidence on synthetic data. It does not prove a
production-sized capture, live provider execution, remote media delivery or
replacement of the user's installed rolling Test Contour. Those outcomes must
be recorded separately; no `fullParity:true` is inferred from these checks.

The separate 2026-09-11 production-sized capture/preparation check retained
1,364,262,912 SQLite bytes and a catalog of 20 Workspaces, 255 Streams and 323
Threads. Counts of remapped fields (one Workspace and 38 Streams) are not catalog
totals. Raw hashes, runtime/ledger bytes and canonical journal/read-model table
hashes matched after preparation. This check did not launch that copied runtime.

## Module ownership

Effect classification and branding live in `src/ports/contour-external-effects.mjs`.
They contain no filesystem or environment access. The filesystem adapter verifies
recording markers and writes local exclusion evidence; configuration, environment,
profile, command mapping and rollout policy live in `src/infrastructure/filesystem`.
Pure operational-path and project-configuration projections live in `src/domain`.
Startup orchestration uses `src/application/contour-effect-operations.mjs`.

Old ignored WIP scripts remain historical evidence and may reference earlier
module locations. They are not current executable entrypoints. All tracked
production and test imports use the owning modules.

The first live prepared cohort exposed historical catalog entries whose containing
project differs from their exact Thread directory. Read projections preserve
these canonical paths and validate membership separately from strict admission.
Local thread/name/set stores provider-scoped mutable names separately from seed
identity; renaming never admits a command or starts a turn.
