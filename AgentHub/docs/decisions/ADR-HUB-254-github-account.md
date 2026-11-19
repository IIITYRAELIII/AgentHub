# ADR-HUB-254 — One connected GitHub account for Hub Git work

## Decision

The revised user request replaces the historical signing/participant/server-rules
proposal. No repository plan, signing key, GitHub App, server rule or Utilities
change is required by this implementation.

In the local Server/Accounts panel the user supplies a personal access token.
Hub verifies `/user`, uses the account's Git-compatible name (or login), and selects its verified
Git-compatible primary email when permitted. Without that email it uses GitHub's numeric
account noreply address. The account is shared across Streams. The selected account
and Git profile are visible; reconnect/disconnect are explicit controls.

The credential is encrypted by Windows DPAPI CurrentUser, in a directory protected
by the existing runtime ACL owner. There is no plaintext/non-Windows fallback.
Only the encrypted credential and public account metadata are saved. The existing
local control boundary excludes token-bearing actions from durable command receipts;
neither a Task nor a provider instruction receives the token.

Each connection has an immutable encrypted credential file. The same atomic public
Git include selects its connection identity and account metadata; both Git and
the API read that selection. Replacing the include publishes a connection only
after its credential is durable. A refused replacement preserves the previous
account and Git identity together; a lost write acknowledgement is read back only
for the same intended connection. Disconnect publishes the empty profile before
removing the prior encrypted credential. Cleanup refusal reports retained encrypted
data explicitly and never reverses or misreports the selected account. Missing or
mismatched selected credentials fail closed. This source format has not been
delivered and introduces no migration of an existing user's connected account.

An atomic public Git include supplies name/email, a GitHub-only credential helper,
and GitHub SSH-to-HTTPS URL rewrites. Internal owned Git inserts that include after
legacy synthetic user defaults. Codex and Claude receive its stable public path;
Codex's invocation additionally sets only those public shell variables, preserving
unrelated settings and security filters. Persistent children read new profile bytes
for each new Git command, so account changes need no turn interruption. GitHub CLI
uses an account-aware launcher on the provider PATH; its credential lives only in
the actual gh child and accidental exact-token output is redacted across chunks.
While connected, gh account-switch/token/global-setup commands point back to the
Hub controls instead of exporting the credential or modifying global Git auth.

The account service serializes only its own local writes. An older asynchronous
connection cannot undo a later disconnect/reconnect. Credentials are generation
bound; stale helpers cannot use a new token with an old profile, or clear a newer
connection's rejected state. A 401/rejected credential exposes reconnect state.
A 403 remains a permission refusal, not proof of expiry or permission to switch
accounts. API requests never redirect an Authorization header to another host.

Actual runtime cutover pauses this owner's intake and drains admitted credential
validation/writes before backup/instance release. Reversible restart recovery resumes
the same owner; finalization disposes it. The existing durable backup scope includes
the encrypted `data/github-account` directory. No provider turn is stopped to switch
accounts, and an unknown external effect does not gain replay authority.

The existing isolated test runner strips only this inherited Hub profile/include
and gh path before starting test code; unrelated Git inputs keep their existing
refusal guards. A child Hub similarly consumes that public launching capability
and binds its own configured data root, so an isolated runtime never adopts the
parent Hub's connected account. This is not a new credential cache or test authority.

## Existing writer inventory

| Writer | Treatment |
| --- | --- |
| Task snapshot, bootstrap, integration, retention/squash/absorption commits in `task-git-workspace.mjs` | Shared owned Git include |
| Ordinary Task native merge in `native-release-merge.mjs` | Same include; this retained filename is not the removed release worker |
| Retained-resolution `commit-tree` in `native-merge-reuse.mjs` | Same include |
| Existing private-destination bug-report commit | Same include; report destination and path guards remain |
| `owned-native-object-store.mjs` synthetic anchors | Bind current public Git identity once to the original archive operation before creating anchors; retain captured DAG bytes |
| Codex App Server shell and Claude detached worker | Public profile/gh path through their actual spawn environments |
| Offline `tools/source-export.py` history projection | Preserve historical attribution; no ambient account rewrite |

Git global configuration and signing keys are neither installed nor modified.
Merge transfers preserve original commit objects. This is a shared default profile
and credential route for trusted Hub work, not a sandbox against malicious code
running as the same OS user or a server-side ban on deliberate Git overrides.
Provider security policies may still refuse access; this does not waive them.

## Validation and delivery

Focused tests exercise real Git from both production provider launch paths using
isolated deterministic model executables, a real managed Task snapshot, immutable
historical objects, reconnect/disconnect, DPAPI, native credential plumbing,
generation/host refusals and private HTTP authorization statuses. These are isolated
checks, not real model turns or a claim that a user's account is already connected.
Production browser files are exercised in Edge at desktop/mobile sizes, with token
clearing, draft retention, expiry/reconnect, localStorage and overflow checks.

Independent review and ordinary Task Test remain required. Actual installation and
the user's connection to GitHub are separate Root-owned/application actions. No
production account, credential, Git configuration, repository rule or history is
changed while preparing this source.

## Protocol references

- [GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Git credential helpers](https://git-scm.com/docs/gitcredentials)
- [GitHub CLI credential environment](https://cli.github.com/manual/gh_help_environment)
- [OpenAI Docs: shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)
- [OpenAI Docs: configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)
