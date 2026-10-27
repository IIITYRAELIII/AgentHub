# ADR-HUB-329: Git origin after partial OWN publication

Status: accepted implementation proposed for corrective release review.
Date: 2026-10-27.
Contracts: REL-001, MCP-001, PERF-001, SYS-001.

## Problem and owner

The original release advanced origin before its runtime was rolled back. Its
full publication state correctly remained uncompleted. Ordinary correction Test
then compared origin only with that older completed publication baseline and
refused the already published OWN commit. Moving main, inventing an incoming
adoption or claiming runtime success would erase the distinction.

## Decision

The existing ReleaseOperationStore reads a single SQLite snapshot of its original
authorization, immutable candidate generation and step receipts. It requires
exact authorized membership, native manifest selection, Workspace/repository,
published/agreed bases, applied validation and admitted exact effective target.
The whole generation identity and receipt argument hashes remain mandatory.
An admitted publication plus actual matching origin establishes only the Git
fact; its partial/failed status is retained. Ambiguous or altered owners refuse.
No new ledger, publication writer, recovery operation or caller approval exists.

Closed installed-local-source provenance optionally binds that derived original,
generation/identity and candidate commit/tree. The same native Task/candidate
owners freshly rederive it and check current main/origin/tree and ancestry.
Existing installed bytes, manifest, source patch, selected-content preservation,
original notes, process/lease and terminal CAS checks remain required. The exact
published commit can supply historical metadata/context, never arbitrary remote
or rolling-dev content. Prepared reuse and immutable generation capture repeat
the proof. Old provenance without this binding keeps its old interpretation.

## Evidence and limits

Focused tests exercise actual ordinary Test, Await terminal persistence with
late origin drift, same-original terminal repeat, prepared reuse and generation
freeze. Read-only owner tests reject missing/changed receipts, authorization,
generation, repository/base/selection and ambiguous originals. Real original
publication evidence is read only; tests write only their disposable fixtures.
The former release, its runtime rollback and recovery hold remain unchanged.
No successful installation, publication or full-suite claim follows from this
proof. This interpretation is needed while a partial OWN Git publication and an
older completed baseline coexist; ordinary completed-baseline behavior remains
unchanged after normal successful delivery.

Affected commands:

- `node --test tests/infrastructure/persistence/own-git-publication.test.mjs`
- `node --test --test-name-pattern="^own partial Git publication" tests/infrastructure/filesystem/native-installed-adoption.test.mjs`
