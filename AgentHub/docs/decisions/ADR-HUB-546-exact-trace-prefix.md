# ADR-HUB-546 — Verify an exact trace prefix before reusing its projection

Each interactive quote uses its existing exact-group worker. A cold request
validates and hashes the requested source prefix. The worker may retain up to
four projections, each covering at most 256 trace groups and 1 MiB of serialized
group data for one turn. A prefix ending in an incomplete line or whose
projection exceeds the budget is ineligible for reuse.

Before reusing a projection, the reader hashes the validated prefix again from
the open file. Path, file identity, session generation and turn scope select a
candidate. The digest of the current bytes authorizes reuse. A mismatch goes
through the full parser. With verified bytes, the reader continues at the next
record using the captured turn and reasoning sequence. A later duplicate in the
same turn still refuses the exact lookup. Frozen snapshots keep their original
byte length and hash, even while the provider appends content.

The original quote command records the worker's return interval separately from
its queue and read times. Direct HTTP quotes also record the local session and
browser device session waits. Those measurements contain only fixed labels and
timing values. Existing browser resource timing continues to cover the matching
HTTP response where the browser exposes it.
