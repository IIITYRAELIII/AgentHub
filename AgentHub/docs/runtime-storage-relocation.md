# Runtime storage relocation

`runtime_relocation.py`, `runtime_relocation_process.py` and
`runtime_relocation_cutover.py` implement one explicit operator-owned transfer.
They are not a runtime service, release installer, retention daemon or business
state owner. Source/destination mappings, machine paths, credentials and
operation receipts remain outside tracked source.

## Authority and preservation

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

## Focused verification

Choose a disposable destination-volume fixture directory and set
`AGENT_HUB_TEST_TMP`, `TEMP`, `TMP` to it. From `AgentHub`, run:

```text
python -X utf8 -B -m unittest discover -s tests -p runtime_relocation_test.py -v
python -X utf8 -B -m unittest install_test.RuntimeLocationTests -v
python -X utf8 -B -m unittest install_test -v
python -X utf8 -B -m unittest discover -s tests -p install_extension_storage_test.py -v
node --test tests/infrastructure/filesystem/runtime-layout.test.mjs tests/providers/codex/codex-hook-launcher.test.mjs
```

From the repository root also run the mandatory PowerShell quality check. Existing
unrelated baseline failures must be disclosed separately from focused results.
