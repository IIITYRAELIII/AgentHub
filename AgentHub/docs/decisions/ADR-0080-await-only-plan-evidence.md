# ADR-0080: Git evidence only for the prospective Await set

The public plan read walked every Workspace Task, including archived Tasks,
before the domain projection filtered Await. A recorded request took 624 seconds
while the MCP response deadline was 60 seconds. The archive had 364 Git references;
per-command timings were unavailable, so no exact latency attribution is claimed.

Resolve Git evidence only for non-archived Await Tasks, after applying the
prospective acceptance and explicit selected membership. Retain metadata needed
by draft and legacy audit projections, including their unchanged plan hashes.
Observe dev through read-only Git commands; never call its preparation owner from
a plan read. Missing refs remain explicit errors in the dev observation.

This does not weaken acceptance, composition, publication or cleanup validation.
No new cache, increased timeout, historical state rewrite or retry owner is added.
Behavioral checks cover a large archive, empty Await, selected and prospective
membership, invalid accepted results, and a real dirty dev worktree.
