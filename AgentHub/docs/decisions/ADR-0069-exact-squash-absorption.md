# ADR-0069 — Exact squash absorption

Status: accepted

The user chose a deliberately narrow squash path instead of a general framework
for manually reviewed Git histories. A full tested source result is transferred
into one new tested survivor result without requiring source Git ancestry. The
source and survivor cards and audit history remain; independent release
ownership moves to the survivor.

The existing Task lifecycle outcome is the durable owner. One pending workflow
transition reserves both Task IDs. The Git phase changes `dev` by one
expected-old ref CAS to an integration whose first parent is exact old dev,
second parent is the new survivor result and tree is the confirmed resolved
tree. The database phase atomically updates both Task rows and the survivor Git
reference. Recovery reuses that transition and reads the exact Git effect before
retrying anything.

Preview authority uses the preview request ID, while confirmation and recovery
retain their own immutable MCP receipt IDs. Confirmation therefore reuses an
unchanged content hash in a separate call without weakening request argument
idempotency. A stale hash/revision/Test state is a typed terminal refusal before
the lifecycle intent; failures after intent retain unknown-outcome semantics.
After the expected-old ref CAS, managed dev is materialized through a temporary
Git administrative/index view using native `--no-overwrite-ignore` checkout,
then the real index advances only from its exact old tree. Exact ref, HEAD, index
tree and clean worktree readback precede the SQLite outcome. Concurrent tracked,
ordinary untracked and ignored file/directory bytes are preserved and leave the
operation unknown. Recovery needs no fabricated process guard when every Git
child ended normally, but an actually unresolved guard keeps its existing exact
proof requirement.

Transfer authority is content-addressed. It separately binds the survivor's
previous accepted result, the reviewed clean-before commit, and the new clean
result. Exact source-completeness witnesses cover the source result, while exact
application witnesses cover only the clean-before-to-clean-after owner delta.
Paths outside that delta cannot change. Foreign overlapping content is allowed
only as an explicit entry in the confirmed evidence and cannot simply discard
the new delta. This preserves excluded dev residue even when it existed in the
previous broad survivor result, while ensuring a new selected file or function
really enters dev. A zero-tree-change synthetic parent fails.

Release projection verifies the durable evidence again from Git objects and
admits the exact clean survivor result only through a conflict-free automatic
merge with the preceding selected composition. The composer does not replay the
broad rolling-dev delta and does not accept a manually resolved release merge.
That projection is mandatory while the survivor result is absent from the
approved base: any normalization, Git-read, identity, witness, ownership or
merge-boundary failure stops candidate preparation and checkpoint reuse rather
than entering the ordinary optional-projection fallback. Once the exact result
is already contained in the approved base, no pending squash projection is
required. After publication, cleanup may use that same proof in place of
impossible source ancestry, but only for the unchanged clean source head and
exact published survivor. No general automatic-merge exemption, secondary
registry, broad dev snapshot or direct database/ref escape hatch is introduced.
