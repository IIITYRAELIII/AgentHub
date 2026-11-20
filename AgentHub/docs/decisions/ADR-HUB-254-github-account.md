# ADR-HUB-254 — One connected GitHub account for Hub Git work

## Decision

The revised user request replaces the historical signing/participant/server-rules
proposal. No repository plan, signing key, GitHub App, server rule or Utilities
change is introduced by the original PAT implementation. The later OAuth request
adds an owner-registered OAuth App, not the historical signing/server-rule design.

The local Server/Accounts panel now starts GitHub OAuth device authorization with
"Войти через GitHub". The public `githubOAuthClientId` configuration names the
owner's registered OAuth App with Device Flow enabled. There is no bundled client
secret, borrowed GitHub CLI client identity or change to the user's gh/global Git
configuration. The existing client/vault/profile consumers remain the base; only
the token acquisition path changes. A missing Client ID gives an explicit setup
error without making an authorization request. Registration is external owner work.

The requested scopes are `gist read:org repo workflow`, matching the existing
Git and GitHub CLI authorization verified for this change. These cover gists,
organization read access, repository operations, and changes to Actions workflow
files. The actual grant remains subject to GitHub consent, account permissions,
and organization policies including SSO. The Hub uses the authenticated account's
numeric noreply address when the grant cannot read private email addresses.

The protocol stores the device code only in the current local service invocation,
returns only the user code/constant GitHub verification URL to the protected local
page, and respects interval/slow_down/deadline/denial. Each poll is bound to its exact
attempt; concurrent polls share one request. Shutdown, cancellation, disconnect and
newer sign-in fence late completion before atomic publication. No background flow
is restored after restart. Network errors are fixed messages, never raw responses.
Only explicit local sign-in starts a replacement attempt.

OAuth access-token expiry is stored with the existing encrypted credential row;
all Git/gh/API token consumers refuse expired authorization. The UI offers sign-in
again. Refresh tokens are neither requested explicitly nor retained: if GitHub
returns one under default expiring-token settings, it is discarded and the user
signs in again after expiry. No second refresh-token lifecycle/store is introduced.
The old PAT service primitive remains the verified token/identity publication path
and supports existing fixture/programmatic callers; the public UI/control starts
OAuth rather than collecting a PAT. The approved PAT source/review/Test remain
history under their original identities.

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
connection's rejected state. Cancellation/replacement invalidate authorization at
admission, then their acknowledgements join the existing credential write queue.
Revision checks after selection and encryption discard a superseded unselected
credential. Once publication is in flight, that same queue owns its actual
outcome/readback and old-credential cleanup before reporting the selected winner.
A cancelled older flow cannot silently publish after an old-selection reply.
Quiesced snapshots join that section too; normal live snapshots do not wait on
credential writes. Internal writer readback uses the same private projection
without recursively awaiting itself. There is no new ledger, queue or rollback.
A 401/rejected credential exposes reconnect state.
A 403 remains a permission refusal, not proof of expiry or permission to switch
accounts. API requests never redirect an Authorization header to another host.
The gh boundary checks host/repository selectors and the command's positional
repository or API/resource address. Body, notes, title, formatting and query
values remain opaque content, including external links; they are not destinations
for the connected account. The pure argument reader uses complete value-option
roles and aliases for GitHub CLI 2.96.0, including nested commands, attached/equals
short values and boolean clusters. Help identifies command/flag names only;
actual compiled pflag parser probes establish next-value consumption, including
NoOptDefVal. Rendered help descriptions are not type/arity authority. A focused
test independently checks those roles through parse-failing completion probes
before command execution. The decorative Copilot --remove Bool is source-verified
because that command disables pflag parsing; the delegated program is not launched.
The data is source grammar,
not a runtime help query/cache or a command allowlist; unknown commands are still
forwarded to gh. Positional resource slots are distinct from local key/archive
paths, release tags/assets and query text. Named template/source repository options
retain their own destination checks; a formatting template remains content.

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
Production browser files are exercised in Edge at desktop/mobile sizes, with the
existing question disclosure, device-code waiting/cancel/reconnect, no PAT input,
localStorage and overflow checks. Private HTTP fixtures exercise the actual device
protocol and shared token consumers without GitHub registration/grants/publication.

Independent review and ordinary Task Test remain required. Actual installation and
the user's connection to GitHub are separate Root-owned/application actions. No
production account, credential, Git configuration, repository rule or history is
changed while preparing this source.

## Protocol references

- [GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
- [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [OAuth App registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [Git credential helpers](https://git-scm.com/docs/gitcredentials)
- [GitHub CLI credential environment](https://cli.github.com/manual/gh_help_environment)
- [OpenAI Docs: shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)
- [OpenAI Docs: configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)
