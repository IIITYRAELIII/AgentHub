# ADR-HUB-237 — Exact trace reads across large non-agent records

## Context

Selecting current commentary requires an exact source-group read before an
annotation can be created. The existing reader rejected every raw JSONL record
over 4 MiB, including old compaction snapshots and large user inputs which are
not agent trace items. A retained real incident reports `source-read-failed` and
HTTP 400; the unchanged worker reproduces `Trace record exceeds read budget`
before reaching the selected commentary. Increasing the general record or page
limits would also admit larger agent evidence and is unnecessary.

This decision refines ADR-0077 and the explicit-detail paragraph of PERF-001.
The previous universal raw-record cap becomes the scoped exception below.

## Decision

Keep the existing exact-detail history owner and rollout worker. For a raw
record over 4 MiB, validate its complete JSON structure and string escapes using
an internal representation bounded by the same 4 MiB budget. Large string values
may be elided only in that representation. Long object keys and an oversized
representation remain errors. Classification occurs after the complete projected
record parses successfully, never from a substring, truncated prefix or sampled
tail.

Only a positively identified top-level `compacted` record, or a top-level
`response_item` whose payload is `type=message` and `role=user`, may be excluded
from agent trace processing this way. The projection never supplies a group,
provider item, lifecycle transition, current turn or source locator. Original
record bytes remain untouched and are included in the full raw-prefix SHA-256.
This is not a partial user-message projection or a second history store.

Oversized agent, lifecycle, unknown or unclassifiable records still refuse.
Invalid JSON or escapes, incomplete oversized records and ambiguous exact group
IDs still refuse. The existing 50-group/512 KiB page bounds, canonical generation,
fixed prefix byte length and full raw-prefix hash remain mandatory. Appends do
not change an already bound prefix; mutation of even an excluded record changes
its hash and invalidates that snapshot. Provider/Thread/turn/item identity,
rendered prefix, UTF-16 range and all annotation hash checks are unchanged.

## Consequences and evidence

The reader continues to stream 64 KiB chunks through the fixed prefix for every
explicit page. Validation and hashing are linear in that prefix's byte length;
large histories can still take seconds. This correction removes a demonstrated
availability failure, not the linear scan cost. It introduces no background
read, polling, provider request, source rewrite or automatic preview exception.
The retained representation bound is not a total heap/RSS guarantee: raw or
projected buffers, parsed ordinary records, chunks and the bounded page coexist.

Focused worker evidence covers large compaction/user records, unchanged source
bytes, append and excluded-record mutation, duplicate IDs, foreign turns,
oversized agent/lifecycle records, malformed escapes, long keys and incomplete
records. Browser evidence covers current commentary selection through the real
worker while the live DOM is replaced, followed by draft creation, reload and
exact source navigation. The retained actual incident's selected native item and
content hash agree after the corrected read. Runtime adoption and authenticated
deployed-UI validation remain separate release-owner work.
