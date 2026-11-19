# Certify unchanged published entries absent from the automatic native merge

Status: implementation for independent review and delivery.

## Context

An ordinary Task retains its agreed base while containing sealed publication
and earlier own work. Captured dev and current Task can have both the publication
and an earlier own result as native merge bases. Dev has since deleted published
files that the Task left unchanged. Git's real automatic merge preserves those
deletions, including when another path requires an ordinary conflict resolution.

Selected-content replay still uses the agreed Task base in this topology.
It can reinsert whole published files. The former automatic-entry comparison
credited only present entries, so the exact absent automatic output was reported
as missing Task work. Simply removing that presence check would also credit
automatic deletions of earlier own work, which must continue to refuse.

## Decision

Keep the replay lower-boundary rule: only the exact unique published merge base
replaces the agreed Task base. For any new absence credit, consume the same
original native Test publication evidence, exact Task/result/before binding and
agreed-base ancestry. Require that publication among the independently read
merge bases, then compare complete selected-source and publication tree entries.

Only when the whole entries match by mode/type/OID and the independently
computed automatic merge and candidate both omit that entry may its absence
count as preserved inherited content. An empty automatic map for a contained
result is insufficient. A source-owned earlier or new change, missing publication,
unrelated publication or changed entry retains the previous replay checks.

The public native graph proof still validates ordered parents, the whole
automatic tree outside conflict paths, immutable resolution bindings and clean
conflict context before selected content. Nothing is copied from rolling dev.
The TaskGit owner continues authenticating and rereading original publication,
source, lease and CAS; no new authority, path list, cache, writer, Task baseline
or historical journal rewrite is introduced.

## Verification and limits

The real Git regression builds two native merge bases and eight unchanged
published files, then checks the actual native composer and exported graph
consumer. The parent fails on those eight paths; the correction retains absence
and whole earlier/new own contributions. Negative cases cover automatic loss of
earlier and later own work, identity/publication drift, missing authority,
automatic outside content and changed resolution bindings.

The captured real failing graph is checked separately through its unchanged
full native graph/resolution consumer in a disposable object directory.
No historical UNKNOWN is replayed or assigned success by this predicate fix.
Operational application, ordinary Test, acceptance and publication remain
separate owning outcomes.
