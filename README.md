# Agent Hub

A local workspace for Codex and Claude: conversations, task boards, live runs,
history, usage and optional browser, VS Code, Telegram and Android clients.

**99.99% vibe-coded (Codex)**

That is the author's joke, not a measurement of correctness or reliability.

Agent Hub is under active development. Recovery, migration and release checks
have explicit limits; a passing unit test does not prove production latency,
provider parity or physical-device behavior. Read the
[accepted contracts](AgentHub/docs/contracts/README.md) before changing behavior.

This source tree combines the published 2.0.1 product with the standalone
distribution tooling. Windows packages use the versioned GitHub Releases;
source publication and installed-runtime cutover retain their separate checks.
The preserved `wip/sidoruksv-2026-10-20` branch contains unfinished work and is
outside the selected release. Existing installations keep their current source
and release identities until the release owner's managed cutover.

## Installation and quick start

Use a versioned ready Windows package from this repository's GitHub Releases
when a reviewed package is available. Verify its published SHA-256 before
running the installer. Installation does not require cloning this repository,
running npm or compiling the native host. The ZIP, descriptor, installer and
checksums belong to the same versioned release.

You need Windows, a Node.js runtime with `node:sqlite` (22.5 or later; 24 or later
recommended), and an installed/authenticated Codex CLI or Claude Code CLI.
Provider accounts and their usage costs are separate from Hub. Python and model
downloads are required only for optional local voice processing; the standalone
package installer itself uses Python 3.10 or later. After the managed source
cutover, Utilities retains only a link to this project; it is not a package
installation or update dependency. See the
[ready-package guide](AgentHub/distribution/INSTALL.md). Android builds need their
own JDK/SDK.

For a development checkout, run from `AgentHub/`:

```powershell
npm ci --ignore-scripts
Copy-Item config.example.json config.local.json
# Edit the private copy: project directories, provider and optional components.
$env:AGENT_HUB_CONFIG = (Resolve-Path config.local.json).Path
npm start
```

The full example enables optional components and contains placeholders. Disable
components you do not use; enter real credentials only in the ignored private
copy. The minimal example in `AgentHub/distribution/config.example.json` starts
with optional network/voice components disabled. Never commit the edited config.
See the [operator guide](AgentHub/README.md) and
[journal setup](AgentHub/JOURNAL_SETUP.md) for component-specific setup.

## Update and rollback

Ready-package updates must use the existing runtime installation owner in an
agreed stopped-writer window. They preserve private configuration and data and
retain the prior package for rollback. A rollback changes executable release
selection; it does not undo database migrations or restore user data. Keep a
verified offline backup when a release's migration contract requires it.

The journal sync endpoint is a private `usageSyncServerUrl` setting, editable on
the Server page. Save it and use the ordinary restart flow to apply it. A blank
value disables the connection; a clean public installation has no built-in
server. Use HTTP(S) without embedded credentials, query or fragment. An explicit
value wins over the environment and enrollment metadata.
`AGENT_HUB_USAGE_SYNC_SERVER_URL` is an initial fallback only while that setting
is absent.

Before switching an installed release, the ordinary installer fills a missing
setting from the previous effective address: saved enrollment, then environment,
then the verified previous release's literal default. It never downloads or
executes that old source. Existing settings, enrollment keys, journal data and
sync cursors are preserved; retry does not reset the value. An enrolled client
whose old address cannot be established refuses cutover until explicitly
configured. This is an installed-runtime update path, not a claim that replacing
an uninstalled source checkout preserves an erased hardcode.

The running installation and any original frozen release operation are not
silently redirected by extracting this repository. Development source builds
and public ready packages are different artifacts, with different checksums.

## Data and access

Runtime configuration, conversations, attachments, queues, diagnostics and
provider session files are local/private. When you submit a request, its prompt,
selected context and attachments go to the chosen provider under that provider's
account and policies. Enabling Telegram, Cloudflare/public HTTPS, a team bot or
remote diagnostics adds those services as data recipients. Review each component
before enabling it. Hub's public Git history and release packages must contain
none of your runtime state, credentials or conversations.

Personal historical account rosters, billing mailboxes, device-label overrides
and switch dates are not shipped. The explicit legacy account-backfill CLI may
read an operator-supplied `legacyTeamUsageAccountPolicy` from private config;
without it, that tool makes no database changes. Normal startup/sync does not
load or apply that policy. Recorded account facts and generic projection from
exact observations on the same device retain their existing owners.

Local storage is not end-to-end encryption. Keep the machine and backups private.
Do not expose the local server directly to an untrusted network. Public access
requires the documented authenticated device/session and gateway configuration.

## Development and checks

From `AgentHub/` after installing the locked dependencies:

```powershell
npm run check
npm test
npm run test:installer
npm run test:e2e
```

`npm run test:all` is the expensive aggregate; optional cosmetic, stress and
reliability profiles have their own commands and documented limits. Browser
checks need their declared browser dependencies. See
[CONTRIBUTING.md](CONTRIBUTING.md), [test matrix](AgentHub/E2E_TEST_MATRIX.md)
and [distribution boundary](AgentHub/distribution/README.md).

## Original theme mark

<img src="AgentHub/assets/web-app/themes/gothic/gothic-neutral-mark.svg" width="64" height="64" alt="Original neutral Hub connections mark">

The public source uses an original geometric node mark instead of the traced
Gothic emblem. It is a Hub-created asset; no game emblem or third-party image
was used to draw it. Game and provider marks remain their owners' property.

## Licensing and security

MIT applies to the exported Hub contributions covered by confirmed permissions.
The scoped contributor permissions are preserved in a private evidence archive.
Existing third-party notices and component licenses remain applicable; dependencies,
provider tools and branding are not relicensed by a top-level license. The
exported history, privacy exclusions and source license boundary have undergone
independent review; ready packages require their own artifact checks.

For a suspected vulnerability, follow [SECURITY.md](SECURITY.md); do not post
tokens, private conversations, runtime databases or unredacted screenshots in
public issues. There is no support or response-time guarantee.
