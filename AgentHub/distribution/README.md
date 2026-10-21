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

## Ready packages

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
python -m unittest discover -s AgentHub/distribution -p release_source_test.py -v
python -m unittest discover -s AgentHub/distribution -p installed_package_test.py -v
```

The latter uses the real native host builder, manifest verification and runtime
installation owner with synthetic application/state bytes. It is not product,
provider, production data migration or public download acceptance.

The package must contain a verified prepared runtime, its production dependencies
and native RuntimeHost, plus license/notices and safe first-run configuration.
It must not contain Git, development tests, Bugs, local data/config, diagnostics,
the author's `sourceRoot`, provider credentials or a user profile. Node.js runtime
is required to run Hub; npm, Git, a compiler and a source checkout are not required
on the recipient machine. Voice/Android/Cloudflare build dependencies are optional
and are not silently bundled.

The future Utilities tree retains only a thin download/install/update/rollback
entry under its existing `AgentHub` component and this installation guide. It
must refer to versioned public AgentHub release assets and SHA-256, not private
Utilities assets. No source directory is removed until fresh install, update,
rollback and the exact public download have passed and S2 owns the cutover.
`utilities-entry.json` is the concrete two-file replacement proposal: the reviewed
stdlib bootstrap becomes the existing `AgentHub/install.py` entry and
`utilities-README.md` becomes its installation guide. It applies no deletion or
Git effect. The native installation test materializes exactly those two files in
a source-free recipient directory and invokes that copied CLI for fresh install,
repeat, update, live-runtime refusal and rollback. The old source-build CLI flags
are explicitly retired only at the later managed cutover; no updater component
identifier or participant acceptance is invented here.

## Existing identities and cutover

- Existing Task refs/worktrees, audit receipts and frozen generations stay in the
  old repository identity. A new Git OID is a mapping, never an old publication.
- Original frozen operations retain their original Utilities source, generation,
  receipts and effects. They are not resumed by this tooling.
- The first standalone product must be the release owner's reviewed accepted
  composition. Neither rolling dev/main nor a source-only mechanism carrier is
  a substitute. Preserve incoming and local results through ordinary composition.
- Source-repository registration and future publication origin change only in
  the release owner's managed cutover, after mapping/assets review. Keep the old
  repository available for original-operation reconciliation and active Tasks.
- The C-to-D runtime migration has priority and does not depend on this extraction.
  Migration scratch and export candidates must remain separate from runtime.
- Automatic report discovery/publication requires the existing Utilities
  inventory/team-setup markers, not `AgentHub/package.json`. Standalone source
  and an explicit source-repository argument refuse before Git publication.
  Thin Utilities remains eligible after source removal. The operator must retain
  its private destination: markers identify layout, not remote visibility.

## Current preparation limits

The audited source history and preserved WIP branch are published in the public
AgentHub repository, with confirmed scoped grants and an enabled private
vulnerability channel. The ready Windows product release, exact final selected
composition/prepared standalone runtime, actual public download acceptance and
managed Utilities source-tree replacement remain separate delivery stages.
No source audit, repair runtime or synthetic installer test substitutes for them.
