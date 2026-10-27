# First standalone source baseline

The first standalone delivery had no repository-scoped previous release: the
existing baseline owner accepted only an already published GitHub Release.
Creating a fictitious or empty product release to satisfy that precondition
would falsify delivery. An arbitrary publication-state write would bypass its
existing owner.

For canonical public IIITYRAELIII/AgentHub only, the existing `github-baseline`
preview/enable CLI admits explicit `--source-only true` with exact source commit,
tree and operator request identity. This is registration of an already reviewed,
actually published source main, not a product release or runtime installation.
It verifies clean local main/HEAD/tree, canonical origin, GitHub repository and
owner IDs, public visibility/default main, and remote commit/tree. The same facts
are verified again under the existing publication lock before the existing
repository-scoped state writer is called.

Only a repository with no baseline may acquire this entry. Exact repetition is
read-only; any different existing entry refuses. Other repositories, global
published revision/generation and old receipts remain unchanged. Its mode and
deliveryStatus explicitly identify source-only facts. No GitHub release/tag,
Task result, adoption, runtime manifest/pointer or historical OID is invented.

This additional source registration can precede the first archive so the normal
Task Test/Await/freeze owner has a real Git base. It does not retire Utilities,
reassign historical Tasks/refs or switch the installed runtime's update origin.
Their managed cutover still follows actual archive/download/install/update/
rollback acceptance. Existing source worktrees and original claims retain their
repository identities. A fresh ordinary claim in the new repository pins its
own repository-keyed base rather than rewriting an old one.

Source-only bootstrap and completed github-release profile entries do not assert
that the publisher machine installed their runtime. Native Test therefore does
not borrow a foreign installed runtime/source checkout for these entries. Its
existing native binding records the complete repository entry digest, revision
and exact origin, and rechecks them before terminal integration. Only exact
published metadata is admitted as a metadata base; no additional code/history
base, selected result, upstream adoption or version/notes waiver is granted.
Entry/origin drift refuses. Ordinary installed-runtime publication keeps its
previous proof and binding. Completed archive publication records its explicit
profile in the same repository evidence, so future work retains this distinction.

The accepted published-source reader and metadata context are retained when
joining this source-only branch. A matching installed publication verifies its
immutable commit and unchanged pointer/manifest, then returns no carry without
reading a disposable generation checkout. Other installed repairs keep their
complete legacy proof. Published metadata credit requires its registered
generation/whole-entry hash/commit/tree and ancestry in both source and dev,
including for source-only entries. An original captures and rechecks that exact
context; old originals gain no field. Native-main candidates match the same
published-base provenance and recheck before their existing commit. No version
or notes waiver, additional source-only code base or ref move is introduced.

The existing task-await-cutover --ordinary-test entry runs that accepted source
through normal public Test/CAS and the actual native reviewer verifier. Closed
arguments, clean pinned source, current Task and canonical repository are
checked before dispatch. Initial-native and cross-Task cutover modes cannot be
mixed with it. Ordinary Await remains its separate unchanged owner.

The normal release still needs accepted exact Task results, source closure,
original notes, validation selection, immutable preparation and its authorized
target. This registration cannot settle any unknown effect or mark delivery Done.

Focused checks:

    node --test tests/infrastructure/persistence/github-source-bootstrap.test.mjs

    node --test tests/infrastructure/filesystem/published-installed-source.test.mjs tests/infrastructure/filesystem/published-native-metadata.test.mjs

    node --test --test-name-pattern="ordinary Test CLI" tests/interfaces/cli/task-await-cutover.test.mjs

Real disposable Git repositories and the existing publication-state/Task Git
owners cover first registration/repeat, preservation of another repository and
global authority, local/remote drift, explicit existing CLI dispatch, and native
Test with foreign installed-source bytes left unchanged. GitHub API and exact
remote reads are controlled ports; this is not live source registration.
