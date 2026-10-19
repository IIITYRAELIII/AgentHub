# ADR-0095: Bound ordinary published conflict resolution

Status: implementation proposed; source acceptance and installed delivery are
separate, and the existing publication workflow remains required.

An ordinary reviewed Test application can be valid while its independently
computed merge against published main still conflicts. ADR-0093 correctly
refuses a release projection in this case. A separately reviewed published
witness was not an input to that owner and could not supply the missing
authority.

Extend the existing ordinary selected-composition owner with one optional,
strict envelope. Bind the immutable Task/base/application and application
bundle to the exact published revision/generation and remote, then independently
compute OWN and the automatic published merge. Require a resolution commit
whose sole parent is that publication. Resolve exactly its actual owning
conflicts with named regular-file blobs; retain automatic clean OWN entries and
every outside-OWN mode/type/blob. Refuse arbitrary trees, extra edits, missing
conflicts, rename/delete/type changes and unbound or stale witnesses.

Include the canonical input and independently derived release tree/stages in
the existing proof hash, original operation and durable receipt. Retain the
published bundle beside the application bundle under that operation. Public
MCP, the existing reconcile CLI and release net projection carry this identity
without introducing another writer or registry. Fresh pre-CAS mismatches have
no ref or Task effect. Existing private-byte materialization, SQLite CAS,
original-ID recovery and crash boundaries remain authoritative.

Omitting the optional input preserves accepted clean ordinary and legacy joined
proof shapes/hashes. An unresolved published conflict without proof remains
refused. This does not approve installation, mutate publication or Task base,
expand legacy UNKNOWN settlement, repair joined self-delivery, or change
selected-result successor coverage in release candidate reuse.

Validation uses synthetic real Git/SQLite public preview, confirmation, reload,
same-ID recovery and hard-death fixtures, plus immutable consumer application
and full published OWN tree equality. Source-ready evidence is not installed
admission or delivery evidence.
