# Keep sealed publication context when repeating a contained Test

## Context

A failed lifecycle persistence can leave a correctly integrated Task result in
dev. A later ordinary Test captures that result as already contained. Its unique
merge base is the selected result, so requiring the publication itself as that
base made selected-content replay fall back to the older agreed Task base. The
replay then demanded inherited obsolete published files again, even though all
own changes and the later integration context were preserved.

## Decision

Extend only the existing published replay boundary: for one exact bound native
Test, the unique merge base may instead equal its selected result when that
result contains the same independently sealed publication. Keep the existing
publication generation/repository/record hash/commit/tree, Task/result/before,
source-publication and agreed ancestry validation. TaskGit still authenticates
and rereads its canonical publication, source, lease and CAS bindings.

Replay the complete selected delta from publication onto the candidate. Do not
skip contained work, trust reachability as content, supply an automatic merge
map for contained results, add absence credit or rewrite a base/ref/journal.
Earlier/new own edits, deletions, modes, entry types and binary content remain
subject to the same full graph/content/resolution checks. Multiple-base and
noncontained policies stay unchanged. Missing/foreign/changed authority refuses
through its existing owning fences.

## Evidence and limits

Focused real Git regressions cover preserved inherited removals/context and a
reopened contained journal, own early/new/deletion/mode/type/binary loss, exact
identity and canonical publication drift, with a real TaskGit repeated-Test
consumer. The exact retained failing graph is checked separately in a private
object database; it is not a replay or settlement of a live original operation.
Normal product Test, Contour, acceptance and publication remain separate owners.
