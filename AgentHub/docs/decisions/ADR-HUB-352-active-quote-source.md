# Active quote source provenance and streaming DOM replacement

Status: implementation proposal for independent review.

The existing quote owner requires exact provider, Thread, turn and item plus a
versioned surface/group, UTF-16 range and three SHA-256 boundaries. Visible live
reasoning can precede the selected answer item; the answer item's ID therefore
cannot establish a different reasoning surface's native identity.

Carry actual provider `sourceItemId` on the existing trace group projection.
The event owner passes the actual event item ID, the rollout owner uses its raw
provider item ID, and full history/persistence retain it. Missing, generated or
invalid IDs do not become source authority. Commentary uses its existing native
rollout/history `commentary:` group namespace consistently in live events too.
Group labels remain bounded with the existing trace-ID helper. Persistence
retains the full group ID within the already accepted source-locator300 limit;
it does not cut the actual native item ID or add another identity registry.

The client binds a selected trace surface to that native group item even while
the current answer item is absent or later changes. A full exact-group source
read remains mandatory for Codex. A streaming rerender may replace the DOM while
that read is pending: re-resolve the same unique source identity and exact group,
require unchanged rendered text and preserve the full-source prefix, exact
offset and hash guards. Recheck the current source after asynchronous hashing.
No text search, previous-final substitution or synthetic provider item is used.

Legacy parent-item/group locators retain their existing hash interpretation,
including when a new full source read supplies additive native provenance. New
metadata is not permission to retarget an old locator. Remove this guard only
when authoritative retained projections provide actual native item provenance;
unbound legacy sources stay safely unavailable. No eager history rewrite.

The existing content-free client trace records a fixed action and bounded refusal
stage. It never records quote/message content or raw error text. Diagnostics do
not change source authority or the generic user-facing refusal toast.

Evidence covers real provider event reduction, raw rollout/history agreement,
SQLite reopen and bounded native IDs; actual DOM selection→draft→send→citation
and completed-history reload on desktop/mobile; neighboring group rerender;
missing/foreign/replaced/group/item/range/source-read refusals and payload-free
diagnostics through the actual trace normalizer. Existing long-source and
triple-click exact range/hash controls remain intact. Controlled evidence does
not identify the original screenshot's unique runtime branch or claim installed
application. Alias output and Guide changes remain a separate Task result.
