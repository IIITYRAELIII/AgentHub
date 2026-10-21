# ADR-0329 — Separate public source from private runtime and Utilities

## Decision

Prepare a standalone public AgentHub source repository and versioned ready
packages. Utilities retains its distribution entry after a managed replacement
is proven. Preserve the `AgentHub/` source prefix to keep existing release
metadata paths. The previous `TelegramIntegration/` prefix stays in historical
commits where it actually existed; merging both namespaces would lose files at
the rename boundary.

Extract only project history into a new object store, with explicit private-file
exclusions and reviewed metadata. Verify every projected tree and retain a
private old-to-new OID mapping. Do not copy all Utilities objects/refs through an
alternate or mirror, rewrite Utilities history, or retarget existing operation
receipts. Public approval requires the entire export and ready assets to be
checked, contributor rights confirmed and independent review completed.

State-directory exclusions apply at the project root. They must not remove
`src/runtime`, executable configuration modules or their tests merely because
a directory or basename resembles installed state. Dependency/cache and private
report exclusions remain recursive. An executable Git projection test retains
those source bytes while proving excluded synthetic state blobs are absent from
all exported objects. Correcting the filter invalidates previous projected
history plans: newly retained versions require the same complete privacy and
ownership audit before export approval.

MIT is the selected license for code covered by confirmed ownership/permission;
it does not relicense third-party code, binaries or trademarks. Draft license and
security documents must not claim that these prerequisites are complete.

The existing prepared runtime is the input to a ready package, not permission to
start another build/publication. A public copy without the author's sourceRoot
has its own manifest/checksum identity and retains the original manifest hash.
The installer delegates pointer and stable-launcher transitions to the existing
runtime installation owner under its publication lock in a stopped-writer window.
It never starts/stops a provider, performs a release Git operation or restarts Hub.
User configuration/data and original unknown operations are preserved.

## Automatic reports

Old report discovery treated `AgentHub/package.json` as Utilities identity. That
would also match the public standalone source checkout. Require the existing
Utilities inventory/team-setup markers for automatic report publication, both in
discovery and before publication even with an explicit repository argument.
Thin Utilities remains discoverable after its source package is removed.

Markers identify the legacy layout, not public/private remote visibility. The
existing private destination must remain private; no public source repository is
silently substituted. An installation without that destination reports an error
instead of creating or pushing a public report. Historical read-only report
capture remains available from an explicitly retained repository.

## Evidence and migration boundary

Use native Git projection/merge/tree checks, synthetic scoped installer tests
with the actual native host builder and runtime owner, archive integrity/path
negative cases, and real isolated report Git tests. They do not establish public
asset availability, product/provider acceptance or production data migration.

The runtime disk relocation takes priority over source extraction. Source removal
and publisher origin cutover happen only after working replacement and the
release owner's exact mapping/accepted-composition checks. The preparation has no
authority to reinterpret or replay an original frozen generation or UNKNOWN.

## Private configuration continuity

The public source has no personal account roster or built-in sync endpoint.
Personal legacy account epochs/participant/device-label mappings move to the
existing private configuration owner, read only by the explicit legacy backfill
CLI. Missing policy is a no-effect outcome before opening SQLite. Generic exact
device/timeline inference remains projection-only and unchanged; no new scheduled
account migration or replacement receipt is introduced. Existing migration keys
and applied markers retain their original meaning.

The existing Server configuration writer owns `usageSyncServerUrl`; explicit
empty means disabled. Installed updates seed a missing setting before publishing
the new runtime pointer, preserving the old effective enrollment/environment/
verified-release default precedence. Extraction of a literal never executes old
code. Failure preserves old pointer authority; an added setting remains backward
compatible with the old release and makes retry idempotent. Credentials, sync
cursors and journal files are not rewritten. Clean installs have no private
fallback. A missing/unverifiable enrolled endpoint fails closed. This is not a
second installer, daemon, runtime-data ledger or permission to update the live
installation outside its existing owner.

All historical versions of personalized modules, fixtures and private endpoint
defaults must be excluded from the public object store. Generalized code and
synthetic fixtures are restored as a declared new source delta over the accepted
audit baseline. Original private Git history/config custody and frozen release
provenance remain separate and unchanged. A passing HEAD test does not approve
the public history or a runtime package.
