# UI checks through public behavior

UI maintenance for HUB-436 replaces assertions about JavaScript spelling with
executable requirements. A renamed local variable, an equivalent branch or a
function moved into its existing projection owner must not invalidate coverage.
The original failed release run remains a separate result.

## Replacement map

| Retired fragment or source assertion | Maintained executable coverage |
| --- | --- |
| `followUpMode`, `taskChanged`, full-render/early-return spelling | `message-start-feedback.test.mjs` exercises default queue and explicit steer; `message-render-dom.test.mjs` repairs a foreign physical message owner through both public message APIs; `message-view-controller.test.mjs` preserves sibling nodes and rejects changed suffix metadata. |
| History mapper body extracted from `hub-client.js` | `message-lifecycle.test.mjs` calls the complete stateless history projection factory exported by `messages/lifecycle.js`. The production client uses the same factory and supplies its existing ports. Identity, phase, chronology, annotations and focused-turn controls remain unit assertions. |
| Paged-history sandbox with implicit adjacent helpers | `active-history-projection-dom.test.mjs` loads the whole client and the real Desktop history factory, including a live question excluded from durable history, older pagination, repeated conditional reads and exact question identity. |
| Private prepend body | `message-lifecycle.test.mjs` calls the complete `messages/projection.js` API used by the client. Repeated overlapping pages retain distinct provider/Thread entities. |
| Private navigation generation / routed-bootstrap bodies | `navigation-intent-dom.test.mjs` drives registered public intents and real routes with held reads: late success, late rejection, invalid route, five superseding intents, direct Thread and stable Stream startup. `rotation-history-production.test.mjs` exercises real Desktop selection/history across both task orders and a held old-Thread response. |
| Raw WebView/HTTP timeout, polling and HTTP retry bodies | `client-policy-dom.test.mjs` observes scheduled budgets and public requests, occupied/idle cadence, provider-accepted timer updates, targeted rename, creation-result selection and actual document reload. `control-retry-dom.test.mjs` asserts four blank-gateway attempts reuse command/message/submission identity; a definite application rejection is sent once. The lifecycle retry/error classifier controls remain. |
| `deferredEntriesForTask` and extracted queue renderer | `client-canonical-state-dom.test.mjs` shows retry/cancel only in the exact Stream even when another Stream shares its Thread. `composer-production-wiring.test.mjs` retains actual current queue and exact-steer decision cases. |
| Private outgoing/receipt author helpers | `client-canonical-state-dom.test.mjs` drives canonical deferred and receipt snapshots: exact origin, repeated updates, withdrawn authority, mismatched alias and literal envelope-like user text. It asserts emitted message metadata and unchanged bodies. |
| Private compaction observer / rotation renderer | The same whole-client file covers active/unknown/timeout/completed/estimated states, absent measurement authority, failed rotation, exact IDs, bounded latest-event ownership and no persistence writes for unchanged polling. It checks the real notice on desktop/mobile, source→notice→target order and recreation after reload. `message-render-dom.test.mjs` keeps the expanded activity tooltip check. |
| Private live-cache mutation bodies | Whole-client cases preserve generated attachments, clear a drained run, and absorb a pre-turn card using the exact client identity. `terminal-live-card.test.mjs` retains the real terminal indicator and new-turn controls; the lifecycle cross-Thread negative remains. |
| VS Code extension source names / resource-root spelling | `render.test.js` invokes the real provider: runtime prepare/readiness transition, disposed panel fence, closed missing-resource outcome, actual catalog/resource loading, allowed roots and exact attachment resolve/open/copy/save identity. Existing emitted HTML asset/CSP assertions remain packaging checks. |
| Generated journal script spelling | `vscode-journal-dom.test.mjs` executes the complete generated HTML: theme messages/state, heading, moved rate-limit chips, duplicate collapse button, refresh and explicit empty disclosure state after recreation. |
| Stable Stream / multi-column / delayed-image source duplicates | The maintained rotation, parallel-history, closed-chat, durable-final, stream-tabs and composer cases exercise these behaviors through their existing APIs and DOM. Their meaningful oracles are retained; source-text duplicates add no behavior coverage. |
| Browser audit executable pin | `file-transfer-browser-feasibility.test.mjs` launches installed Chrome and Edge by Playwright channel. Both retain the interrupted download and rejected unsigned-resume cases. No audit checkout/configuration selects Chrome. |

Paths in this table are relative to `tests/public/`, except the lifecycle
composition suite and `VSCodeExtension/render.test.js`. This correction does not
claim removal of every historical source assertion in unrelated theme,
statistics or backend architecture suites. Those checks are not replacement
evidence for the client behavior above.

## Owning defects exposed by the stronger checks

Canonical deferred attribution was updated in memory without a render request.
The existing client now requests a batched, scroll-preserving render only when
the canonical patch changes, and also renders a newly restored card. Repeated
unchanged snapshots do not introduce another state owner or message identity.

A successful compaction was published after its failed rotation, hiding the
later failure under the existing one-event maintenance bound. The same owner
now publishes the failed rotation as the latest event and avoids alternating
two persisted projections on unchanged polling. Task context retains its
canonical compaction result and measurement; no extra event cache is added.

## Fixture and measurement boundaries

The production fixture models `select-task` and its deferred snapshot response,
instead of replying with an empty object that the real client interprets as an
empty full snapshot. Held existing history reads are answered by their original
IDs; they are not abandoned or replayed. Read requests interrupted by a real
document reload receive an aborted fixture transport, never a fabricated
business success. Browser contexts, routes and child processes are joined.

The trace join retains the outer diagnostic identity for the inner control
request. The original business message and idempotency identities are unchanged;
tests retain the no-payload telemetry assertions. The cold-selection check joins
selection, history and confirmed visible history paint, and separates held
selection I/O from render work. Its synthetic Desktop/SQLite measurements are
not production selection latency or a production SLO. Production mixed
`ui-render` percentiles remain separately attributed, without inferring a
selection duration or a cause from them.

Use named failed/affected cases after a correction. Do not rerun the full release
suite, the expensive long final-history cases or a browser matrix with unchanged
inputs solely to produce a new aggregate. Runtime installation, release
membership and original user-window acceptance belong to their normal owners.
