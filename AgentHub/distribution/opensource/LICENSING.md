# License preparation boundary

`LICENSE.MIT.template` is a draft for the confirmed owner's own code, not an
automatic grant over other contributors or third-party components. The name is
present in the owner's Git author metadata; the source history begins in 2026.
Do not rename this template to `LICENSE`, set package metadata to MIT or publish
until contributor rights and the export's exact license scope are confirmed.

The existing Utilities repository had no detected general license. Direct
contributions from other named participants must be covered by actual permission
or rights ownership. Acceptance for internal use does not establish a relicensing
grant. Original contributor attribution and applicable notices must survive.

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
- Images, themes, logo/provider marks and historical design references require
  provenance review. Existing generation notes are evidence for the specific
  assets they name, not a blanket license for every binary in the history.

`build_package.py` emits `DEPENDENCIES.json` from actual packaged runtime files,
with package names/versions/license declarations and hashes of shipped adjacent
notice files. It does not relabel `SEE LICENSE` or undeclared licenses as MIT.
The complete ready archive and its dependencies still require review before
public publication. Runtime state and build-machine paths are never notices.
