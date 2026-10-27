# Source and distribution boundary

This is preparation for a repository cutover, not permission to retarget an
existing release operation. The registered release owner still composes,
validates, prepares and publishes the exact accepted source. The package builder
consumes its already prepared immutable runtime; it does not build, deploy,
restart, push Git, change Task results or publish a second release.

The standalone repository keeps `AgentHub/` as its source directory. This retains
the accepted `AgentHub/package.json` release metadata paths. Its root contains
the public README, license, contribution/security guidance and Hub-only
release notes. Historical `TelegramIntegration/` paths remain only where they
actually existed in the extracted development history.

Files under `opensource/` are reviewed draft root overlays, not an automatic
publish operation. `release-notes.example.md` becomes root `CHANGELOG.md` only in
the independent export. Its template name deliberately respects the managed Task
rule excluding files named CHANGELOG.md. MIT scope and the real private reporting
channel are documented in the reviewed public root overlays. Those source
approvals do not accept a runtime package.

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

## Version identity

The first installer targets the corrected public **2.0.1** release. The immutable runtime/artifact version
is `2.0.1+build.N`, with the real allocated N, not a display counter. Runtime
manifest `version` and `publicVersion` are `2.0.1`; `releaseVersion` is the
artifact identity, `buildNumber` is N and `versionScheme` is `semver-build-v1`.
Inner package inventory, outer descriptor and saved PACKAGED inputs agree on
all these fields. The original nine-field PREPARED receipt remains unchanged:
its `version` and CLI `--version` are the artifact identity.

Public GitHub tag/installer `--release` is `2.0.1`, **not** `2.0.1+build.N`.
A published tag cannot be overwritten with another N. The release owner binds
that public tag to frozen source/build/manifest and asset digests. Stable
`latest` discovery still refuses beta/rc releases. Prerelease grammar and
precedence are supported in isolated identity/update checks, not implicitly
selected by the stable channel.

The existing allocator reads retained runtime manifests and verified Android
codes, with an epoch-minute floor, under its installation lease. A frozen N
is reused on retries; a competing allocation refuses before preparation. There
is no package-side allocation or new counter. Unknown/foreign/partial retained
metadata refuses rather than being deleted. Legacy calendar receipts keep their
original identity. Ordinary verified updates permit calendar → 2.0.1, then
nondecreasing semantic precedence and increasing N. Exact reinstall is reusable;
explicit rollback uses the verified previous pointer. Config, data and enrollment
remain untouched by this version migration.

## Ready packages

For the first standalone source only, after its exact source/history review and
public push, use the existing baseline owner on the clean standalone main:

```powershell
npm run release:policy -- github-baseline preview --project-root <standalone-repo> --owner IIITYRAELIII --repo AgentHub --source-only true --target-commit <reviewed-public-main> --source-tree <reviewed-public-tree> --request-id <stable-registration-id>
```

The corresponding `enable` action with the same exact values adds only an absent
repository-scoped source baseline; repeat is read-only and conflicting existing
evidence refuses. It does not invent a GitHub Release or installed runtime.
Then use ordinary Task claim/Test/Await and the original frozen release owner
in that repository. Old Utilities claims, refs, Tasks and receipts remain under
their original repository identity. Additional source registration is preparation
for the first package; actual source retirement/update-origin cutover still waits
for public download, fresh install, update and rollback acceptance.

The tracked offline packaging checkpoint is the normal interface for the release
owner after canonical preparation:

```powershell
python AgentHub/distribution/build_release.py --prepared-receipt <owner-prepared.json> --receipt-sha256 <receipt-sha256> --source-commit <exact-reviewed-export-OID> --version <frozen-artifact-version> --license <confirmed-LICENSE> --notices <actual-shipped-notices> --output-root <private-build-root>
```

The existing release/build owner supplies those arguments from its saved exact
release input, not by editing a per-version script. It creates the hash-pinned
receipt with exactly these fields: `schema: 1`, `phase: "PREPARED"`, original
`operationId`, positive integer `generation`, `sourceCommit`, `releaseId`,
`version`, absolute `releaseRoot` and original `manifestSha256`. `version` must
equal the manifest's `releaseVersion` (or its legacy `version` if absent); the
stage neither allocates a suffix nor patches a manifest. A receipt is an input
identity, not new acceptance or authority to publish its source.

`build_release.py` uses the existing packager and recipient archive verifier. It
verifies the manifest's complete declared runtime payload on every invocation,
binds license/notices and packaging-tool hashes, and writes an exclusive
`<output-root>/<version>/intent.json` before artifacts. Its only public asset
directory is `assets/`, containing exactly `AgentHub-win32-x64.zip`, its `.json`,
the versioned `install_release.py` and `SHA256SUMS`. The checksums list the first
three files. Private original receipt, intent, failure and result metadata stay
outside `assets/`; never upload the whole checkpoint directory.

A successful checkpoint persists `result.json` with `phase: "PACKAGED"`, original
operation/generation/source/version/manifest identity under `inputs`, an
`inputIdentity` SHA-256 and the four exact asset names/sizes/hashes. Calling the
same command revalidates the prepared input and saved package/inner inventory,
then returns that exact saved result without another pack, version allocation or
publication. A different input/tool/license/notice, changed artifact, foreign
file, missing result or partial pair refuses and preserves the original files.
Even a complete ZIP without the committed result is not completion; inspect the
original failed/unknown checkpoint through its owning release operation. This
tool does not delete or silently rebuild it. Its file writes are exclusive and
flushed; this is not a notarization, filesystem snapshot or independent signature.

Runtime preparation and publication remain existing release-owner stages. The
existing `createPublicationArtifactSteps` owner accepts an optional
`runtimePublication: { operationId, generation, sourceCommit, version }` copied
from the exact frozen release input. Its runtime artifact identity includes all
four fields. `prepareRuntime` checks `expectedReleaseVersion` against the canonical
next suffix under the existing installation lease before copying, Host compilation
or locked dependency installation. A mismatch refuses; it never changes a manifest
or allocates an arbitrary version. Publication version and artifact version are
distinct inputs and must not be silently relabeled.

For newly frozen generations, the existing release freeze records the public
semantic version and the canonical next `runtimeReleaseVersion` separately in
the same immutable manifest and freeze intent. It reads the configured runtime's
existing release metadata; it does not reserve a suffix or prepare a runtime.
The canonical publication runner passes that exact version, original operation,
generation and frozen commit to the artifact owner. A later competing allocation
therefore causes an explicit mismatch under the installation lease. Repeating a
freeze or resuming its prepared artifact retains the original version. Historical
generations without this field keep their original artifact identity and do not
acquire a newly invented PREPARED receipt.

After normal preparation, `artifacts.preparedRuntimeReceipt(identity)` verifies
the original artifact, full runtime and frozen source/version, then returns
`{ receipt, receiptFile, receiptSha256 }`. The exact nine-field JSON is retained in
that artifact's immutable payload. Pass its file and hash to `build_release.py`
above. A completed artifact, or a verified prepared body whose build reply was
lost, is reused before another preparation/allocation. Partial bodies without a
manifest and changed original inputs refuse and remain available for inspection.
This is an existing-checkpoint adapter, not another preparation or approval ledger.

The original release owner can explicitly authorize an `agent-hub-publication`
target with environment `github-release`. Its ordinary frozen runner prepares
the runtime, invokes this packaging checkpoint, publishes Git, then uploads the
exact four assets to its own digest-bound draft and publishes that GitHub Release.
The target must use the registered standalone public repository. It does not
install or restart the publisher, deploy Worker/Android or install VS Code.
Normal targets retain their installed-runtime behavior. Original generation,
version, source, journal and tests selection remain authoritative; there is no
manual receipt, asset upload or alternate publication CLI.

This implementation still requires exact source/current-context review and the
ordinary standalone candidate lifecycle. Its existence does not prove that a
product archive was built or publicly downloaded. Actual product download, fresh
install, update, rollback and managed cutover remain separate completion evidence.

The publisher's prepared runtime is an input, not a trigger for another build:

```powershell
python AgentHub/distribution/build_package.py --prepared-runtime <verified-release-directory> --source-commit <reviewed-exported-commit> --license <confirmed-license-file> --notices <complete-notices-file> --output <new-versioned-zip>
```

The resulting ZIP and its adjacent checksum JSON are new artifact identities.
The original prepared manifest and receipt are preserved. Only its copied public
manifest drops the private machine `sourceRoot`; it retains the original manifest
SHA-256 and identifies the exported source separately. This new package still
needs the release owner's normal validation and public artifact acceptance.
Its source commit must equal the prepared manifest's publicationRevision. An old
Utilities artifact cannot be relabeled with a rewritten AgentHub OID: after the
reviewed source cutover, the existing release owner must prepare the runtime from
the accepted standalone source. Repository/selection authority remains with that
owner; the packager does not manufacture a new adoption or receipt.

For discovery, publish the owner-accepted ready ZIP under the fixed asset name
`AgentHub-win32-x64.zip`, plus its adjacent `AgentHub-win32-x64.zip.json`, in the
same stable GitHub release. The builder emits the descriptor with exact package,
source, manifest and outer checksum identities. Its `publicApproval: false` is
preparation metadata, not an approval flag to flip: only the existing release
owner's reviewed publication admits assets. This tool does not upload a release.

The recipient can select an exact stable tag (or explicitly `latest`):

```powershell
python install_release.py --release <exact-stable-tag> --runtime-root <private-runtime-directory> --scratch-root <separate-private-temporary-directory>
```

The fixed anonymous API origin is `IIITYRAELIII/AgentHub`; Utilities is never an
update origin. No token or GitHub CLI is read. One bounded release response pins
both versioned asset URLs, GitHub SHA-256 digests and sizes. Missing digests,
duplicate assets, unpublished/prerelease metadata, cross-repository URLs and
descriptor/ZIP/inner-manifest disagreement refuse before Node execution. The
descriptor and ZIP are independently hashed against that response; this is not
an author signature or immutable-release guarantee. Additional `--sha256` pins
the chosen ZIP even when using discovery. API redirects are refused; asset
redirects retain the existing canonical HTTPS host restrictions.

Alternatively the recipient supplies an exact version/checksum:

```powershell
python install_release.py --url https://github.com/IIITYRAELIII/AgentHub/releases/download/<version>/<package>.zip --sha256 <published-sha256> --runtime-root <private-runtime-directory> --scratch-root <separate-private-temporary-directory>
```

Use `--archive <local-zip>` instead of `--url` for offline installation. Run the
same command with `--rollback` to select the verified previous runtime through
the existing installation owner. Neither command starts or restarts Hub. Runtime
and temporary roots must be separate; stop all writers through the existing owner
before update. The bootstrap refuses a live/unknown runtime process and holds the
existing publication lock. It does not establish a new stop-all-writers protocol.

Focused preparation checks, with `AGENT_HUB_TEST_TEMP` on the intended volume:

```powershell
python -m unittest discover -s AgentHub/distribution -p package_test.py -v
python -m unittest discover -s AgentHub/distribution -p build_release_test.py -v
python -m unittest discover -s AgentHub/distribution -p semantic_package_test.py -v
python -m unittest discover -s AgentHub/distribution -p release_source_test.py -v
python -m unittest discover -s AgentHub/distribution -p installed_package_test.py -v
```

The latter uses the real native host builder, manifest verification and runtime
installation owner with synthetic application/state bytes. It is not product,
provider, production data migration or public download acceptance.
It invokes the same packaging CLI twice for each actual native prepared fixture,
proves saved result and all artifact bytes/mtimes stay unchanged, then uses the
resulting package for install/update/rollback. The dedicated checkpoint suite
also exercises real package integrity, cutpoints and reparse refusal. These
tests do not promise bitwise reproducibility of independent full product builds
or replace the required real public download and installer acceptance.

The package must contain a verified prepared runtime, its production dependencies
and native RuntimeHost, plus license/notices and safe first-run configuration.
It must not contain Git, development tests, Bugs, local data/config, diagnostics,
the author's `sourceRoot`, provider credentials or a user profile. Node.js runtime
is required to run Hub; npm, Git, a compiler and a source checkout are not required
on the recipient machine. Voice/Android/Cloudflare build dependencies are optional
and are not silently bundled.

The future Utilities tree retains only a brief public AgentHub link in its
existing inventory/documentation. It contains no Hub source directory, installer
copy or release assets. The reviewed `install_release.py`, ready packages and
[installation guide](INSTALL.md) live in standalone AgentHub. This supersedes
the earlier two-file Utilities bootstrap proposal.

`utilities-entry.json` records that future link-only metadata handoff, with an
empty Utilities file-copy list. `utilities-README.md` is the short link text for
the existing inventory, not another retained AgentHub folder. Neither file
applies Git, updater, uninstall or deletion effects. No source directory is
removed until the exact public download, fresh install, existing-user update,
rollback and managed source/origin migration have passed and S2 owns the cutover.
Original Tasks/WIP/receipts/history and private consent evidence stay preserved.

The current `UPDATER/imports.json` has no AgentHub import registration. Existing
`agent-hub`, `tool:agent-hub`, `app:agent-hub`, `runtime:agent-hub` decisions and
optional component choices remain historical participant consent, not uninstall
instructions. Do not delete them or manufacture another acceptance/update owner.
At cutover retire source-build guidance from the current inventory; standalone
versioned AgentHub assets remain the update origin. Removing Utilities sources
must not delete/stop the installed runtime, config, data, sync URL/auth/cursors
or disable standalone updates. Old CHANGELOG entries remain historical records.

The native installation test invokes a copy of the standalone installer from a
source-free recipient directory. It checks fresh install/repeat, then removes an
owned synthetic legacy Utilities source folder and checks update/live refusal/
rollback with the same runtime and unchanged participant choices/config/data.
Only transport is synthetic; no actual Utilities source removal or public
download acceptance follows from this fixture. No graphical Setup.exe is added.

## Existing identities and cutover

- Existing Task refs/worktrees, audit receipts and frozen generations stay in the
  old repository identity. A new Git OID is a mapping, never an old publication.
- Original frozen operations retain their original Utilities source, generation,
  receipts and effects. They are not resumed by this tooling.
- The first standalone product must be the release owner's reviewed accepted
  composition. Neither rolling dev/main nor a source-only mechanism carrier is
  a substitute. Preserve incoming and local results through ordinary composition.
- Additional first-source baseline registration above may precede the first
  archive solely for ordinary candidate preparation. Managed source retirement
  and installed update-origin cutover follow mapping/assets/consumer acceptance.
  Keep the old repository available for original-operation reconciliation and
  active Tasks; their existing identities are not rewritten by registration.
- The C-to-D runtime migration has priority and does not depend on this extraction.
  Migration scratch and export candidates must remain separate from runtime.
- Automatic report discovery/publication requires the existing Utilities
  inventory/team-setup markers, not `AgentHub/package.json`. Standalone source
  and an explicit source-repository argument refuse before Git publication.
  Link-only Utilities remains eligible after source removal. The operator must retain
  its private destination: markers identify layout, not remote visibility.

## Current preparation limits

The audited source history and preserved WIP branch are published in the public
AgentHub repository, with confirmed scoped grants and an enabled private
vulnerability channel. The ready Windows product release, exact final selected
composition/prepared standalone runtime, actual public download acceptance and
managed Utilities source-tree replacement remain separate delivery stages.
No source audit, repair runtime or synthetic installer test substitutes for them.
