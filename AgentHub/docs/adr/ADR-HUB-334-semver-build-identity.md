# ADR-HUB-334 — Public SemVer and original artifact build

Status: proposed with HUB-334 implementation; source review and delivery required.

## Decision and owner

The user selected SemVer and explicitly assigned **2.0.0** to the first public
installer. Calendar dates remain release dates. Public policy is patch for
compatible corrections, minor for compatible features, major for incompatible
supported interfaces or update compatibility. SemVer prerelease ordering and
build-metadata rules follow https://semver.org/ (9–11).

`src/domain/agent-hub-version.mjs` owns pure parsing/precedence/identity. The
existing filesystem release-version owner selects the new public version;
`freeze-publication-candidate.mjs` freezes it. The existing retained-manifest
allocator/installation lease owns N. No second store, reservation, writer or
publisher is introduced. Semantic N is the maximum observed recognized build,
verified retained Android versionCode and epoch-minute floor, plus one, bounded
by Android's existing 2,100,000,000 limit. Partial/unknown/foreign retained state
fails closed. Old metadata is not renamed or repaired by this operation.

## Immutable interfaces

Public version is `2.0.0`; artifact is `2.0.0+build.N`; internal releaseId
remains independent. New runtime manifests expose `publicVersion`, `buildNumber`
and `versionScheme: semver-build-v1`. Their `version` is public, releaseVersion
is artifact. Package inventory/descriptor and saved input identity repeat those
explicit fields. runtimePublication still has exactly four fields; PREPARED
still has exactly nine. Their version and Python --version remain artifact.
Original calendar receipt/generation bytes remain unchanged/readable.

Freeze observes N without reserving it. Expected artifact N supplies the same
floor N-1 when preparation later rechecks under the existing lease. This avoids
wall-clock drift on retry but still refuses any retained competing allocation.
The existing artifact checkpoint reuses a verified prepared body before another
preparation, including lost replies. Android receives the same frozen artifact,
uses N as code and public version as name, and checks actual output metadata.

## Update and presentation

Machine version remains artifact. UI label is `2.0.0 · сборка N`. Stable public
tag and --release selector are `2.0.0`; the existing stable channel does not
become a beta channel. S2's publication checkpoint must bind tag/public version
to exact frozen build/source/manifest/assets and refuse overwrite/retag with a
different build; this Task does not add a second publication path.

Verified calendar installation may migrate to major 2 or later. Subsequent
ordinary updates require nondecreasing SemVer precedence and increasing build;
metadata alone is never precedence. Unknown identity refuses. Exact manifest
reinstall reuses the original artifact; explicit previous-pointer rollback keeps
its existing separate authority. The migration does not clear config/data,
change signer/package ID, bypass stopped-writer checks or retarget an old release.
The calendar compatibility reader can be removed only when retained original
operations/receipts no longer require it, through a separately reviewed migration.

## Evidence and limits

Focused behavioral tests cover semantic ordering, calendar migration, unknown
metadata/downgrade refusal, original frozen floor, competing allocation, original
freeze/crash reuse, exact four/nine-field interfaces, Python package cutpoints,
public-tag binding, UI label and actual Java update guard. The native installer
fixture builds the existing Host from reviewed source and checks fresh install,
calendar→semantic update, preserved config/data/enrollment, running refusal,
downgrade refusal and explicit rollback. It uses synthetic app/state bytes;
no historical opaque executable or production update is required.

S2 owns final compatible source composition, public artifact freeze, actual
Android build/device verification, download/update acceptance and delivery.
Source tests do not claim a public 2.0.0 package or installed version.

## Publication consumer correction

`prepareCommittedAgentHubReleaseVersion` requires the original expected public
version and never selects a next patch implicitly. The full publication CLI
uses the same canonical freeze owner as changed publication and passes its
returned immutable version into validation. Only new freeze/preparation selects
a version. After normal metadata save, retry validates that same selected value;
missing original identity refuses before any metadata write or effect stage.
No additional version receipt, counter or publication path is introduced.

The optional complete freeze return is a projection of the same immutable
publication record (`releaseVersion`, `runtimeReleaseVersion`, `head`), not a
new receipt. Full publication checks the public/artifact relationship and current
source head before metadata validation or stages, then binds that projection
into its existing checkpoint identity. Android receives -ArtifactVersion from
that record. Runtime deploy receives the same expected artifact/source pair and
uses the existing preparation lease/refusal; neither builder chooses a new N.
The default public-only freeze return remains compatible for unchanged callers.
