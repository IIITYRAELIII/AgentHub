# Agent Hub

A local workspace for Codex and Claude: conversations, task boards, live runs,
history, usage and optional browser, VS Code, Telegram and Android clients.

**99.99% vibe-coded (Codex)**

That is the author's joke, not a measurement of correctness or reliability.

Agent Hub is under active development. Recovery, migration and release checks
have explicit limits; a passing unit test does not prove production latency,
provider parity or physical-device behavior. Read the
[accepted contracts](AgentHub/docs/contracts/README.md) before changing behavior.

## Installation and quick start

Use a versioned ready Windows package from this repository's GitHub Releases
when a reviewed package is available. Verify its published SHA-256 before
running the installer. Installation does not require cloning this repository,
running npm or compiling the native host. A public package has not yet been
published as part of the repository extraction preparation.

You need Windows, a Node.js runtime with `node:sqlite` (22.5 or later; 24 or later
recommended), and an installed/authenticated Codex CLI or Claude Code CLI.
Provider accounts and their usage costs are separate from Hub. Python and model
downloads are required only for optional local voice processing; the Utilities
bootstrap itself uses Python 3.10 or later. Android builds need their own JDK/SDK.

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

## Licensing and security

MIT is selected for code whose ownership/permission is confirmed. Existing
third-party notices and component licenses remain applicable; dependencies,
provider tools and branding are not relicensed by a top-level license. The
license/provenance review must complete before the first public push.

For a suspected vulnerability, follow [SECURITY.md](SECURITY.md); do not post
tokens, private conversations, runtime databases or unredacted screenshots in
public issues. There is no support or response-time guarantee.
