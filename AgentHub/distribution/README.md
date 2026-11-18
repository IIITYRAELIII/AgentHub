# Independent package and installation boundary

The application release mechanism is removed (ADR-HUB-463). There is no
release run/continue/get API, release worker, operation generation, freeze,
automatic publication/recovery or automatic Task finalization. No replacement
orchestrator is introduced. Archived receipts, frozen artifacts and SQLite
history remain under their original identities and are not replayed/deleted.

Tasks keep CRUD/history/checklists, managed claim/branches, Test in dev, Await
in PreRelease, native conflict continuation and existing content/authority/CAS
guards. Task Await is acceptance into PreRelease, not installation or Done.

## Manual delivery order

Finish and independently review the change in the existing PreRelease. The
delivery owner sets the agreed version and one consolidated notes entry,
builds an installer from that exact source, installs **from the installer** and
checks the installed application. Correct and recheck failures if needed.
Only the verified result is manually merged into main and pushed. Building
from another source checkout or merely copying files is not installation proof.

The source checkout is not a runtime. Personal data/configuration, archives,
dependencies and build outputs stay outside Git. No additional delivery clone
is required by the application. Version changes and publication are manual
delivery-owner actions; executors do not independently bump Task versions.

## Existing standalone build and ZIP

Use the explicitly pinned external build package, its exact content digest and
the clean candidate commit/tree. See [building.md](../docs/building.md).
The existing path is `src/build.mjs:buildPinnedCandidate` →
`src/runtime-build.mjs:prepareRuntime` → `python/build_package.py`.
The builder compiles RuntimeHost/native companions, installs production lock
dependencies in the new build body and verifies the runtime manifest. It does
not need Hub MCP, release API, operation/generation/freeze or a release recipe.

The returned prepared runtime directory is a build artifact, not a release
operation receipt. Package it with the existing independent Python entry:

```powershell
python <tool-root>/python/build_package.py --prepared-runtime <runtime-directory> --license <LICENSE> --notices <THIRD_PARTY_NOTICES> --source-commit <exact-OID> --output <package-output> --recipient-root <tool-root>/recipient
```

Keep the ZIP, descriptor/checksums and versioned recipient installer together.
Verify the actual output paths and SHA256 before installation. The tool's
`recipient` directory contains its own `install_release.py`, `install-prepared.mjs`
and configuration example. No release-side PREPARED.json is required.

## Install from the archive

The recipient needs Python >=3.10 and Node >=22.5/SQLite, not Git/npm or the
source checkout. Use the versioned installer shipped with the exact package:

```powershell
python <recipient>/install_release.py --archive <archive.zip> --sha256 <archive-SHA256> --runtime-root <existing-runtime> --scratch-root <private-scratch>
```

For a first installation, provide the selected `--project-root` as required by
the existing installer. Existing configuration/data are preserved. Scratch is
private and on the intended volume; archives and extracted package roots are
verified before runtime effects. `--inspect-package` verifies/extracts without
installing. `--prepare-update`, `--update-status` and an original `--operation-id`
address the existing **maintenance** owner, not the removed release operation.
Unknown maintenance outcomes retain the same original identity until readback.

Installation flows through `recipient/install-prepared.mjs` → packaged
`runtime/runtime-maintenance.mjs package-install`. It retains RuntimeHost,
restart/drain, backup/rollback, readiness/readback, immutable runtime identity,
configuration validation and original maintenance receipts. `current.json`,
`releases/<runtimeID>`, runtime manifests, the installation `publication-lock`
and its Windows native lock-publisher companion remain necessary. They do not
grant GitHub publication or release workflow authority.

Check the installed runtime's exact package/source/version, live+Ready identity
and maintenance result. A successful ZIP build, pointer write, subprocess exit
or HTTP reply alone is not a complete installed/readiness proof. Never stop an
unrelated process or delete user data to make an update pass.

## Offline history extraction

Run from a managed Utilities checkout, with output on the migration volume:

```powershell
python AgentHub/tools/source-export.py plan --source . --pin <exact-commit> --output <private-audit-directory>
python AgentHub/tools/source-export.py extract --source . --plan <audit>/plan.private.json --decisions <reviewed-decisions.json> --destination <new-private-bare-repository>
python -m unittest discover -s AgentHub/tools -p source_export_test.py -v
```

Read the entire plan privately. The scanner is a bounded detector, not a
guarantee of secret absence. Review binary content and origins, fixtures, private
addresses/paths, metadata and the entire exported history. Decisions bind the
plan SHA-256 and each flagged/binary blob. They provide explicit allow/exclude
reasons and reviewed public attribution/one-line technical subjects for every
commit. Commit bodies, original email addresses and signatures are not copied.
Do not claim that rewritten commits retain original signatures.

`Bugs`, local state, dependencies, logs, private config and design screenshots
are excluded across the history. Every retained commit is verified against the
exact declared file/mode/blob projection. The mapping and raw audit stay private;
old Utilities refs, original receipts and UNKNOWN results remain unchanged.
Empty excluded-only roots have an explicit absent public identity. A commit whose
filtered tree equals its sole retained parent aliases that parent; it does not
publish a privacy-only commit. The private many-to-one OID mapping records why.
Real multi-parent technical merges remain native merges, and every original
projection is verified against its retained commit or alias. A fully empty source
selection refuses. These aliases never reinterpret an original release receipt.
There is no clone, alternate object store, network or push in the extractor.
Only independently reviewed, sanitized history may later be pushed to the new
repository. A source audit pin is not a release acceptance.

## Historical compatibility

Task Git may read historical published source/base/selected-composition facts
through `task-publication-history.mjs`. These are read-only archived evidence,
not a new release store, writer or worker. Historical SQLite tables, old runtime
retention records and user-authored rules are preserved. No startup release
continuation, publication finalizer, progress server or release-specific Task
completion is installed or launched.

The old external-tool environment variable names remain for immutable package
pin compatibility. Tool updates are separate from application installation and
must not advance a pin used by an active build. No recipe/orchestrator API is
loaded by runtime-manager preparation. Standalone Worker tools remain separate
from the manual desktop package installation.
# Autonomous recipient installer

`install_release.py` is the single-file recipient entry. It needs Windows,
Python and Node.js with `node:sqlite` (22.5 or newer). It verifies the public
package, escapes the calling Hub Job, force stops only the selected installation,
backs up durable state, installs and starts the new version, and checks real
Ready. A failed replacement restores verified prior code and checks old Ready.
The update authorizes interruption of active work in that installation.

Example: `python install_release.py --release 2.1.7 --runtime-root <Hub-directory> --scratch-root <separate-directory>`.
Offline input uses `--archive <ZIP> --sha256 <exact-digest>` instead of `--release`.
An explicitly requested `--resume-partialstop --operation-id <same-original>`
continues the exact retained d148 partial-stop revision3, or its pinned a297
revision5 descendant-parent refusal, after verified previous Ready is restored.
Revision5 retains and revalidates the whole revision3 history plus the retired
a297 worker and its exact input. The same archive/runtime/scratch arguments are required.
The whole prior UNKNOWN and its earlier history are saved by the existing CAS.
Continuation transport directories stay directly under the supplied scratch
root, keyed by original and installer bytes. Prior directories remain linked
through the retained input and canonical whole-row history. They are not nested
again: repeated path growth can prevent SQLite from creating backup sidecars.
Fresh retirement uses retained-handle exit proof, batch process capture and the
existing stop budget. Timing and captured target identities are retained with
the worker evidence. This bounded compatibility ends when those originals are
disposed.

An exited child which disappeared before native capture does not require a
parent effect binding. Live children still require the native original parent
and birth. Native rundown errors remain pending until that same retained handle
signals; a live denied handle never grants stopped backup or installation.
Recovery keeps those original handles across the failed stopping pass.

Ready also verifies the configured local web capability and TCP listener owner
against the authenticated Node and its launched Host. Headless configuration
remains supported. A slow startup is observed while the exact Host remains live;
elapsed time alone no longer triggers rollback. Host exit or an explicit startup
capability failure follows the existing previous-version recovery path.

An explicitly requested `--resume-prestop --operation-id <same-original>` can
continue only the positively verified published8c09 pre-stop foreign refusal;
it preserves the old UNKNOWN/history and never replays backup/install/launch.
Keep the reported retained directory: it contains progress, backup and the
original result. Dispatch is not completion. Repeat the same command to read the
same original without restarting effects. Never reuse an old skipped operation
ID for a new installation attempt. `--prepare-update` uses this same autonomous
entry; no Enter or manual process termination is involved.

The preserved public 2.1.7 archive/old installer are inputs, not files this Task
overwrites. Deliver the new installer as a separately hashed artifact until the
distribution owner updates normal download entrypoints. Historical cooperative
package callers and versioned offline installer bytes retain their own protocol.

## Installer storage lifecycle

New packages record autonomous backup/storage evidence for the existing
after-ready retention owner (ADR-HUB-471). All update backups share the existing
limit of five, including protected recovery copies. Proven unused extracted
payloads and owned downloads retire after terminal disposition and creator exit;
borrowed ZIPs and compact original receipts stay. UNKNOWN is not cleanup consent.
Progress/partial native deletion resumes on the same canonical storage child.

The maintained application JSON CLI supports addressed migration. Feed one JSON
object on stdin to `node runtime-maintenance.mjs installer-storage-register`:
`runtimeRoot`, `operationId`, `cache`, `expectedOriginalSha256` (SHA256 of the
canonical owner's JSON representation). It verifies terminal disposition,
request/worker/script, archive/descriptor and physical ownership. It registers
proof only; it does not delete or rewrite that source original. Old successful
backups with a canonical directory reference also migrate automatically.

For an explicitly accepted legacy partial root with no historical creation
proof, supply `runtimeRoot` and `custody` instead: `previewFile`, `previewSha256`,
`successorOperationId`, `decisionId`. The preview binds the whole failed original,
target/root, file/directory identities and full hashes, zero effects and retired
worker. This requires a real delivery-owner custody decision; it is not a scan.
`custody.inspectOnly=true` verifies it without creating a receipt. Keep the
preview outside the candidate directory. Automatic discovery never adopts it.

`installer-storage-preview` takes `runtimeRoot` and optional `after`; it returns
up to three candidate/eligible binding pairs without deleting. After integration,
ordinary installed startup performs cleanup through the existing service. An
addressed finite `installer-storage-cleanup` input supplies `runtimeRoot` and
`approved:[{ownerId,candidate,binding}]` from that preview. Repeat the SAME binding
for admitted partial progress/readback, not a new filesystem preview over an
already partially deleted tree. Normal readiness/busy/lease fences still apply;
an older live runtime without authenticated busy evidence safely defers this
foreground call. The updated runtime's ordinary background path needs no manual
command. Root owns actual local cleanup and public delivery.
