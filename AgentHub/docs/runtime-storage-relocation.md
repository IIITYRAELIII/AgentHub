# Runtime storage relocation

`runtime_relocation.py`, `runtime_relocation_process.py` and
`runtime_relocation_cutover.py` implement one explicit operator-owned transfer.
They are not a runtime service, release installer, retention daemon or business
state owner. Source/destination mappings, machine paths, credentials and
operation receipts remain outside tracked source.

## Authority and preservation

### Private destination initialization and legacy unowned remnants

Windows destination initialization publishes a marked, private directory rather
than creating an unmarked final destination before an ACL subprocess. The current
process token supplies the user SID; no `whoami` or `icacls` child is needed.
Create-only [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
applies a protected DACL (current user, SYSTEM, Administrators only) and returns
the exact new staging directory handle. Its native file ID is persisted in the
operation-local root-init receipt before marker/publication effects. The marker
is written and checked inside that directory. The same retained handle is then
renamed relative to the held destination parent with FALSE replace through
[NtSetInformationFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile).
Unknown children, streams, changed IDs/parents/ACLs/markers and final-name
collisions refuse without overwriting foreign data. Source-root identity and
plain ancestry are checked. Existing marked legacy roots keep their ownership
format and must still have the exact private ACL grants; canonical ACE ordering
and auto-inheritance bookkeeping do not change the grant policy.

A failed initializer retains its native error/NTSTATUS, subprocess return code
and raw stdout/stderr bytes when available; it does not translate a loader
status into access denied. A known created stage can resume only with its exact
durable ID, parent, private ACL and contents. A crash before the ID receipt leaves
an explicitly unproven stage and refuses automatic adoption. Original failure
logs remain evidence; a controlled injected process exit code does not prove
the historical DLL initialization cause.

An older unmarked final directory is always refused by `ensure_destination`,
including an empty directory. For a separately authorized exact legacy remnant,
the explicit preservation-custody commands are:

```text
python -X utf8 -B runtime_relocation.py preview-unowned-root --plan <plan> --expected-plan-sha256 <hash> --root-index <index> --quarantine <new-path-outside-transfer-roots> --output <new-preview>
python -X utf8 -B runtime_relocation.py custody-unowned-root --plan <same-plan> --expected-plan-sha256 <same-hash> --preview <exact-preview> --expected-preview-sha256 <preview-hash>
```

Custody is NOT ownership/adoption, copied/departed source or garbage deletion.
The preview binds source/target/native ID, both plain parent chains, same volume,
empty/no-ADS boundary and unoccupied quarantine. Confirm repeats all boundaries,
checks current copy-worker absence using the existing process inventory owner,
persists an intent, then renames the SAME held directory without replacement.
The completed receipt retains `ownership: UNPROVEN`. No manifest phase/SQL is
changed. Interrupted confirmation needs the exact object at quarantine AND the
old path absent; changed/nonempty/ADS/reparse/colliding positions refuse and are
preserved. A newly substituted old path is never removed to make retry pass.

Unavailable Python command lines are UNKNOWN, not absent copy workers. If needed,
confirm accepts `--copy-worker-proof <file>` and
`--expected-copy-worker-proof-sha256 <hash>`. The independently reviewed proof
must bind the operation, `checked_at` (at most60s old), and
`foreign_unknown_python` entries containing exact PID/parent/native creation/exe
plus `foreign_evidence: {path, sha256}`. Fresh native QUERY-only custody rechecks
these identities; missing, changed or duplicate classifications refuse. An
observed relocation stage/final-copy/cutover worker always refuses. This is a
bounded operator input, never permission to classify arbitrary writers as foreign.

Before the next offline window, the installer invokes the accepted
`ensure_destination(plan, index)` for every explicit destination, with fresh
no-copy-worker boundaries. This prepares/checks only private roots and markers,
not source payloads; no new stage/full copy or manifest phase change is involved.
Failing preparation remains failed and source runtime availability is preserved.
Only after exact preparation and fresh caller/GLOBAL/source/stop binding does
ordinary same-operation copying resume. Equal-hash cached files are reused;
mandatory hashing, whole-copy verification and SQLite integrity are unchanged.

The runtime installer owns stop/start. Before a transfer, save all source writers
and obtain independent review of the exact scripts, plan, rollback and process
ownership rules. Preserve current/rollback/prepared releases, immutable manifests,
dirty and untracked Task work, Git objects/refs/registrations, original UNKNOWN
operations, queues, command-spool receipts, history, attachments and evidence.
Publication is not a prerequisite for moving useful work; it remains a
prerequisite for canonical deletion of managed work.

The plan binds explicit plain source roots, root file identities, unique new
destinations and an operation ID. Existing destinations are refused. Its local
SQLite manifest describes only copied files and per-entry removal receipts; it
does not replace a Hub ledger or add a permanent journal. No reparse point is
traversed. Supported junction/symlink targets are preserved verbatim. CopyFile
preserves file NTFS streams and timestamps; hashes cover default and named file
data streams. Directory data streams currently fail closed before verification
or switching, including root-directory streams; they are never silently dropped.
Pruning rechecks this boundary through a held directory delete handle that denies
concurrent stream writers. Hardlinks are reconciled within the transfer even if
a source group changes between stage and final-copy or a link rename is interrupted.
Stream metadata is queried through an `OPEN_REPARSE_POINT` handle using
[FILE_STREAM_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_stream_info),
including the reparse point itself. Foreign junction targets are not inspected
or pruned; unaccounted streams attached to a link also fail closed.
Private destination ACLs
protect copied configuration. Directory/MFT allocation is not a file-size sum.

## Preparation

1. Inventory configured roots, services, startup/CLI/Desktop entry points,
   external Hub-owned payload, Git absolute mappings and temporary command spool.
   Exclude shared Node, Codex history, foreign applications and primary source.
2. Check destination capacity and existing contents without overwriting anything.
   Place helpers, manifest, evidence and any fixtures on the destination volume.
3. Create the plan with `plan --plan <file> --map <source> <target>` (repeat map
   only for explicit additional roots). Before staging, `extend_plan()` may append
   separately identified roots without rescanning earlier roots. Freeze and review
   the resulting plan SHA and full helper SHA list.
4. `stage --plan <file> --expected-plan-sha256 <sha>` may copy stable payload
   while writers remain live. SQLite, sidecars and common mutable state files
   are deferred. This is not a coherent database snapshot. A copied file that
   disappears is retained on the destination as departed evidence, not restored
   into the current runtime.

Copy actions accept `--workers 1..8` (default one). Only independent files with
one source hardlink are parallel; real hardlink groups retain serialized custody.
At most twice the worker count is pending. The coordinator alone writes the
manifest, and every worker is joined before success or failure returns. Final
offline copy joins all workers before database-cohort and verification admission.
The frozen cutover config may bind the same bound with `copy_workers`.

To replace a slow live stage, the installer first freezes and reviews its exact
worker/helper/plan hashes and native process identity. `pause-stage` in the existing
process-custody helper takes that worker binding as `--process-plan`, its digest,
and `--worker-helper`. It reopens a held handle, rechecks native creation/executable,
command/parent and absence of children, then stops only that worker. This is not
a main-runtime stop or an all-writers-stopped proof. Preserve its original exit,
stdout and stderr as interrupted/failed unless its real exit proves otherwise.
An already absent worker is never replaced with a new PID as a termination target.

Resume only the same plan/manifest/target with the old worker authoritatively
absent and no other copy writer. A complete exact-operation temporary is consumed
by the original checksum guard. An incomplete one remains refused. After explicit
inspection the installer may call `quarantine_temporary(plan, root, relative_path,
identity, content_digest)` for that one known manifest intent. It preserves all
streams through a same-volume rename into operation-side evidence, records custody
before the move, and resumes an interrupted rename without overwriting evidence.
Unknown temporary names, reparse entries, changed identities/hashes and foreign
quarantine paths remain preserved and refused. This is not a general temp sweep.
Quarantine retries revalidate the entire existing ancestor chain before accepting
retained evidence. Copy and hardlink temporaries use a deterministic short hash
name when appending the operation suffix would exceed the NTFS filename-component
limit; original payload filenames remain unchanged. Earlier temporary names that
fit the limit retain their exact spelling for same-operation recovery.

## One controlled window

The installer launches the frozen cutover helper independently from the destination
with `--config <private-json> --expected-config-sha256 <sha>`. The private input
binds plan/hash, installed Host and manifest hashes, release, saved-stream boundary,
original-receipt witness, output directory and exact arm-turn terminal identities.
The invocation is operator authority, not an invitation to discover arbitrary roots.

The helper waits at most 15 minutes for a read-only SQLite transaction to observe
the exact arm turns completed, with valid terminal timestamps, and an empty
canonical active-run set. Queued/pending identities are captured and preserved;
they are not drained to manufacture idle. Missing/malformed/unknown authority
refuses stop. The final process set is captured afresh after this barrier.

Process ownership is restricted to executables inside mapped Hub roots, known
script hosts with mapped-root arguments, Hub browser profiles, and positively
identified descendants. Generic editor command-line mentions are not ownership.
Each selected native process handle retains its exact executable and creation
FILETIME. All handles and the fresh parent/command/process set are checked before
the first termination. Stops use those same handles, not a subsequent PID lookup.
Include the actual Desktop and configured Hub Caddy, including adopted orphans.
This is a controlled process stop followed by SQLite crash recovery; it is not
claimed to be graceful JS shutdown.

The frozen invocation supplies an explicit `protected_processes` list with exact
native creation times and executable identities. The process owner opens these
with QUERY/SYNCHRONIZE access only. Overlap with the selected stop set or a live
selected ancestor refuses before the first termination. It also queries the
existing named Host job and existing job handles held by selected processes,
using QUERY-only non-inheritable duplicates without CLOSE_SOURCE. Unknown job
limits, failed membership queries, changing handle inventories, or a protected
member in a selected-owner kill-on-close job refuse the operation. All job query
handles close before stopping; they are never kept to mask last-handle teardown.
The existing Host identity is pinned separately as `job_anchor`. No job is
created, reassigned or reconfigured by this diagnostic boundary.

Native handle enumeration may redact kernel object addresses. Those values and
their hashes are never accepted as identity. The guard retains first QUERY-only
duplicates during inspection, independently duplicates the current source handles,
and requires the documented Windows `CompareObjectHandles` same-object witness.
Unavailable comparison or a recycled handle referring to a different object refuses.
Current limits and membership are reread on the matched object. All first/second
duplicates close before stopping; none is retained as a runtime survival mechanism.
The API contract is documented by Microsoft at
https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-compareobjecthandles.

After all selected writers are absent, the helper copies and verifies the entire
offline cohort, including every database and its WAL/SHM files, then performs
read-only SQLite integrity checks. Direct `data/*.sqlite` and `data/*.db` files
are critical: invalid headers or integrity failures prevent switching. Invalid
retained fixtures elsewhere remain byte-preserved and explicitly reported as
failures, never relabelled healthy. Recheck process absence after copy and again
before switch. An expired stop receipt can only be refreshed by the owning
`refresh-stopped` action, which verifies native identities and fresh absence and
retains the original receipt hash.

## Compatibility boundary

Renaming each source to its exact operation holding path and creating a junction
to the destination preserves immutable historical paths and Git registrations.
The old paths contain no payload. Never rewrite hash-bound manifests or primary
worktree metadata merely to make a new root look native.

The initial compatibility mode may launch Host through its original alias if
an isolated probe of the *actual installed binary* proves that BaseDirectory,
child runtime-root environment and IPC root hash retain that logical alias while
native final-file handles resolve executable and writes to the destination.
Hub-scoped TEMP/TMP points to destination `temp`; global TEMP and external tools
are unchanged. Move an existing exact old command spool with every identity, or
declare its absent old path as an empty compatibility alias to the same new spool.
Unexpected source/destination contents refuse the switch. There is one consumer
and no replacement ledger. Root-sensitive clients must keep the same logical IPC
identity until a separately reviewed native-root compatibility change covers them.

`AGENT_HUB_RUNTIME_ROOT` and `AGENT_HUB_TEST_CONTOUR_ROOT` accept absolute machine
overrides in source discovery/installation. Do not set a new logical root for only
one client or assume these source changes are installed by a physical transfer.
Native logical-root discovery, fresh-login TEMP and future extension installation
are explicit follow-up acceptance items in the same storage work, not reasons
to retain hundreds of GiB on the old volume.

The source installer stores new VS Code extension versions beneath the selected
physical runtime root, at `external/vscode/extensions/<publisher.name-version>`.
The shared VS Code extensions directory retains only a per-version junction
(symlink on other platforms); unrelated extensions stay under VS Code ownership.
Inventory accepts an old plain version or an alias to that exact Hub-owned
payload location. A substituted payload ancestor or foreign alias is refused.
Installed revision/provenance, descendant checks, rollback CAS and monotonic
version ordering still belong to the existing extension installer. VS Code owns
retirement of registered older Hub versions; this is not automatic version deletion.

The installer commits a complete physical body before publishing its logical
alias. An interrupted alias publication retains the physical body. An exact
retry compares every staged file and directory, including package, profile and
provenance, before reusing it. Changed bodies, unknown additional files and linked
entries are preserved and refused. No separate extension journal is introduced.
This source capability must be delivered by the runtime installer after physical
relocation, before using an older installer's alias-incompatible extension plan.
The relocation itself does not replace an installed binary or frozen source.

## Acceptance and rollback

### Recovery after a partial controlled stop

`TerminateProcess` is asynchronous. Error5 can mean that termination is already
in progress; it is never accepted on its own. The owner captures the native error
immediately and waits at most10 seconds on the SAME retained process handle. Only
a signalled handle confirms exit. A still-live error5, wait failure or timeout
stops the operation with `all_writers_stopped:false`. No PID lookup, privilege
change, process-tree fallback or job-limit adjustment is used.

The existing stop receipt records each exact PID/native creation/executable intent
before its attempt, then the observed outcome or failed native stage/error/wait.
Successfully stopped entries remain recorded if a later attempt fails. Pending
intent after a crash is unknown, never implicit success. Only fresh final absence
of the whole owned set can admit offline copying.

For a failed attempt before offline copy/switch, retain its original invocation,
output directory, partial stop receipt, log and hashes unchanged. First establish
that the original helper identity is terminal/absent, all source roots remain
plain with their original identities, the same manifest is still planned/staged,
and no pre-switch/start admission exists. Preserve the owned destination cache,
quarantine, dirty/untracked work, refs, original UNKNOWN outcomes and receipts.
Recheck current runtime/source/foreign identities and stop all source work again.
The sole installer then prepares a NEW output/config with fresh actual caller,
saved boundary and original failure evidence, SAME operation/plan/manifest/targets,
for the same reviewer's narrow binding check. Use the ordinary accepted execution
owner: fresh capture and held custody of the CURRENT complete owned set, all
terminal/GLOBAL/protected/ancestry/job guards, whole offline copy and integrity.
Do not replay the old PID order, edit a failed receipt to green, reuse its output
log, skip missing children by raw PID, or infer all-writers absence from partial
results. If copy/switch/start has already been admitted, this procedure does not
apply; preserve both sides for the appropriate explicit recovery.

Microsoft documents asynchronous termination and error5 after exit:
https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess.

Preparation defers the exact dotfile `.lock` as well as ordinary lock suffixes;
it may be range-locked by a live provider. This is preparation only: offline
copy must still read and verify every byte after writers release it. A failed
preparation remains failed, with its exact operation temporary retained.

Before start admission, `rollback` removes only verified compatibility junctions
and restores original source names. Destination copies remain. After
`admit-start`, automatic rollback is forbidden because the destination may contain
new writes. A startup failure preserves both sides for an explicit recovery
through the same offline owner; never silently restore stale originals.

After actual ready, the installer verifies native EXE/data handles, release identity,
normal tools catalog/context/Task operations, real legacy-client read-only IPC,
UI/history/attachments, queues and original receipt identities. Record physical
and logical roots separately. `accept-started --runtime-proof <file>` binds this
operator witness. Only then may `prune-originals` remove exact transferred
originals. It refuses unknown or changed entries, verifies content and file ID
through the same delete handle, never follows links and removes directories only
when empty. Per-entry intents permit interrupted pruning to resume. Retain current
destination writes and the destination-side evidence. Report observed free-space
gain separately from logical byte sums and concurrent disk activity.

The helper never closes the Task or claims retention is implemented. Automatic
retention must use existing artifact owners, protect active/dirty/unpublished
work and required rollback/evidence, and test crash leftovers and repeated cleanup.

### Explicit original-runtime WAL-index drift after verification reads

A read-only SQLite connection can rebuild or alter its shared WAL index. SQLite
documents that the `-shm` wal-index is transient and reconstructible:
https://www.sqlite.org/wal.html#implementation_of_shared_memory_for_the_wal_index.
That fact alone never authorizes deleting a changed source file. The normal
original-prune path continues to refuse every changed or unknown entry.

For this migration owner only, an operator may separately admit the ONE
`data/runtime.sqlite-shm` file in original root0 after destination-runtime
acceptance. First preserve its current bytes on the destination volume through
the existing verified copy owner. Then generate and independently review the
typed preview using the immutable plan:

```text
python -X utf8 -B runtime_relocation.py preview-derived-shm --plan <same-plan> --expected-plan-sha256 <same-sha> --preserved-shm <destination-current-index-copy> --output <new-preview>
python -X utf8 -B runtime_relocation.py prune-originals --plan <same-plan> --expected-plan-sha256 <same-sha> --derived-shm-proof <exact-preview> --expected-derived-shm-proof-sha256 <preview-sha>
```

The preview binds the operation/whole-plan identity, original root/relative file,
unchanged offline manifest row, the SAME native index ID and creation time,
current bytes/size/metadata, and an independent destination-side preservation
file. It refuses reparse ancestors, named streams, replaced files, missing
preservation and arbitrary filename-based exceptions. Source DB/WAL are opened
only as raw files, never as SQLite connections. Their exact original identities
and hashes must match the offline manifest while retained read handles deny
writers/deletion. SQLite and WAL headers identify the configured cohort. Creation
time is read from `FILE_BASIC_INFO` on the same native handle, since Windows
Python path-stat and descriptor-stat can expose different `ctime` semantics.

Pruning still validates the entire original root before its first deletion.
This index is processed FIRST while DB, WAL and preserved copy stay held. The
existing same-handle delete owner verifies the current proof and strict native
metadata, including the actual retained descriptor's single-link count immediately
before disposition, rechecking after hashing because the held file's sharing
mode does not prevent another hardlink name. A link added before that final
observation refuses deletion. This is a same-handle admission check, not an atomic
Windows link-count compare-and-delete primitive. Ordinary
hardlink-group pruning keeps its existing semantics because link counts decrease
as sibling links are removed. Original manifest identity/hash columns remain unchanged. Only the
existing `deleted=2` intent → effect → `deleted=1` progress is used, with the proof
digest bound in the same operation-local manifest state. A failure before/after
effect retains partial state; every retry requires that SAME proof. Missing
untyped old intents cannot acquire authority merely by being retried. Interrupted
post-effect recovery rechecks the held DB/WAL before completing its index receipt.

Old-writer detection uses original holding paths, NOT the logical C aliases now
addressing the running destination. The live destination may keep working and
writing throughout original pruning. Changed DB/WAL, a held writer, foreign or
changed preservation, a different current index, unknown streams or an invalid
proof fail closed. No checkpoint, expected-hash rewrite, source-SQL mutation,
main-runtime stop or additional business-state owner is introduced. This explicit
exception expires with completion of original-source pruning; it is not automatic
product retention or permission to remove any other SQLite sidecar.

### Optional bounded original-file pruning

`prune-originals` remains serial by default. An independently reviewed NEW
invocation may explicitly select `--prune-workers 8`; changing a running worker,
its pinned helper or its invocation is not supported. A prior worker must be
authoritatively absent before resuming the SAME operation/manifest and proof.
Completion of the original worker needs no replacement invocation.

Only ordinary files whose original and fresh identities both have one link are
submitted, at most eight at a time. The coordinator alone commits each existing
`deleted=2` intent before submission and `deleted=1` after observed native success.
The same held delete handle rechecks the single-link condition after hashing.
Hardlink groups, directories, reparse entries and missing-intent recovery drain
all pending work and retain their serial owner. The typed WAL-index remains the
first serial effect with its unchanged proof. Root completion cannot overtake
pending work; failure or cancellation joins every submitted effect and records
known successes before closing the manifest. Unknown results keep their intents
and resume through the same original owner, without altering stored identities.

Small destination-volume timings are component evidence, not source-volume
throughput, physical reclaimed bytes or a production completion estimate.

## Focused verification

Choose a disposable destination-volume fixture directory and set
`AGENT_HUB_TEST_TMP`, `TEMP`, `TMP` to it. From `AgentHub`, run:

```text
python -X utf8 -B -m unittest discover -s tests -p runtime_relocation_test.py -v
python -X utf8 -B -m unittest discover -s tests -p runtime_relocation_protected_test.py -v
python -X utf8 -B -m unittest discover -s tests -p runtime_relocation_stop_test.py -v
python -X utf8 -B -m unittest discover -s tests -p runtime_relocation_destination_test.py -v
python -X utf8 -B -m unittest discover -s tests -p runtime_relocation_prune_test.py -v
python -X utf8 -B -m unittest discover -s tests -p runtime_relocation_parallel_prune_test.py -v
python -X utf8 -B -m unittest install_test.RuntimeLocationTests -v
python -X utf8 -B -m unittest install_test -v
python -X utf8 -B -m unittest discover -s tests -p install_extension_storage_test.py -v
node --test tests/infrastructure/filesystem/runtime-layout.test.mjs tests/providers/codex/codex-hook-launcher.test.mjs
```

From the repository root also run the mandatory PowerShell quality check. Existing
unrelated baseline failures must be disclosed separately from focused results.
