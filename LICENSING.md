# Source license scope

The top-level MIT license applies to Hub code and original contributions covered
by the contributors' confirmed permission. Their copyrights remain theirs; no
copyright assignment is requested. Public attribution uses the contributors'
confirmed GitHub accounts; original emails, private bodies and audit mapping are
not exported. The original Utilities history and receipts retain their identities.

Third-party components, brands and marks retain their own terms. The traced Gothic
emblem and its earlier related geometry are excluded from this public history;
the replacement Hub connections SVG is original geometric artwork.

The scoped personal permissions and exact contribution lists are preserved in a
private archive. They cover the declared existing contributions, without an
automatic grant over future contributions. SHA-256 manifests verify saved bytes;
they are not independent author signatures or trusted timestamps.

The initial public source import is a development snapshot. Actual shipped
dependencies and package notices require separate verification against the
eventual prepared release artifact. No ready package is published by this import.

## Third-party inventory

- Phosphor Icons core 2.1.1 SVG geometry: MIT. Preserve the complete existing
  `AgentHub/THIRD_PARTY_NOTICES.md` in source and packages.
- Gradle wrapper JAR/scripts: Apache-2.0; the tracked JAR carries
  `META-INF/LICENSE`. Preserve that license, wrapper source headers and the
  pinned distribution SHA-256. Gradle/Android toolchains are build dependencies,
  not silently bundled end-user runtime dependencies.
- `jose` and transitive npm modules retain their declared licenses/notices.
  `package-lock.json` pins the dependency graph and integrity values; it includes
  optional platform packages that are not necessarily shipped.
- Claude Agent SDK and its native CLI packages are **not MIT**. The installed
  0.3.286 package's LICENSE.md reserves Anthropic's rights and points to
  <https://code.claude.com/docs/en/legal-and-compliance>. Keep those exact notices.
  Provider authentication and use remain governed by the provider's terms; Hub's
  own license does not license provider binaries, services or branding.
- Node.js, Codex/Claude installations, browser QA binaries, Cloudflare/Caddy,
  optional Python voice packages/models and Android SDK/JDK each have separate
  licenses. Do not claim they are shipped merely because code can invoke them.
- New images, themes, logo/provider marks and design references require
  provenance review. Existing generation notes are evidence for the specific
  assets they name, not a blanket license for every binary in the history.

`build_package.py` emits `DEPENDENCIES.json` from actual packaged runtime files,
with package names/versions/license declarations and hashes of shipped adjacent
notice files. It does not relabel `SEE LICENSE` or undeclared licenses as MIT.
The complete ready archive and its dependencies still require review before
public publication. Runtime state and build-machine paths are never notices.

## Public status header artwork boundary

The public status-header family uses byte-exact copies of the existing unbranded
`assets/notification-cards/background-hex.png`. Provider/group file names are
stable selection keys; the images contain no provider name or logo. All variants
currently share the same artwork. Exact original overlaid vendor-mark blobs are
excluded across both historical source prefixes and retained only in private
Utilities provenance. Contributor permission for Hub code/backgrounds does not
assert permission to redistribute a vendor mark. No runtime provider selection,
status command, receipt identity or model invocation changes in this replacement.
