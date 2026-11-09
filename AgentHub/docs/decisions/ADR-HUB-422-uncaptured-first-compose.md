# Recover an uncaptured first compose on the original release

## Context

A release authorizes public GitHub distribution followed by local installation
from that distribution. Both targets refer to one repository and equal approved
main pins. Mapping targets directly to repository approvals caused a duplicate
approval refusal before generation capture. The original remained failed at
generation zero. Existing first-compose recovery required an already frozen
generation and could not represent this earlier boundary.

## Decision

The Workspace release adapter reuses the existing canonical repository normalizer
and coalesces only equal local and origin pins. It preserves both approved targets
and refuses conflicting authority. The direct preflight remains strict.

Extend the existing first-compose inspection and recovery ports with a typed
`uncaptured-first-generation-v1` binding. The generation owner proves absence of
both the addressed generation directory and its retained archive. Any existing
entry, including an empty directory or partial capture, refuses this mode.

The existing normal prepared-generation preflight verifies the complete current
selection and original main approvals. Inspection binds the prepared plan, commit,
tree and manifest without capture. Actual recovery rechecks those bindings, the
unchanged release metadata and owner, then uses ordinary capture. The original
generation lock repeats physical absence immediately before directory creation.
Mixed captured and uncaptured repositories refuse.

First-generation inspection already owns the non-reentrant Workspace Await lock.
Its uncaptured branch calls the private locked preparation body. The ordinary
public preparation entry acquires that lock once. A real production-lock regression
exercises inspection, refusal, capture and subsequent lock acquisition.

An interrupted outer MCP admission can retain pending or UNKNOWN while the original
release is still definitely failed before capture. The same public continuation
re-enters only the existing first-compose recovery owner with unchanged actor,
arguments and generation-zero CAS. Fresh owner proof precedes its atomic recovery
admission. Only that exact durable recovery identity completes the outer receipt,
retaining the previous diagnostic. If admission committed before a lost reply,
read back the same request binding and let ordinary release ownership continue its
already admitted work. Never repeat capture from missing reply evidence.

The existing release store continues to recheck definite failed compose receipts,
original input, empty registered generations and effects, owner and revision CAS.
It appends recovery and the next attempt on the same original. Generation zero
persists until capture succeeds. No frozen artifact version is inferred from an
absence binding. Later generations keep normal version and input guards.

## Verification

Maintained tests cover equal two-target authority through normal preflight,
conflicting pins and aliases, a real SQLite original failing before capture and
continuing after correction, stale CAS, prepared-source drift, and actual tiny Git
generation custody. Partial, foreign and archived destinations refuse before
capture. Existing retained-frozen recovery remains covered separately.
