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
| Loading/empty message-owner source strings | `chat-surface-behavior-dom.test.mjs`: unread history shows loading; a loaded empty page clears it; a real public message becomes visible. The whole-client foreign-owner case remains separate. |
| Subagent title/disclosure, GFM and separate live reasoning source strings | The same view-owner file renders a collapsed readable child, opens its real disclosure, renders table cells and keeps reasoning Markdown separate from answer Markdown. It loads the whole app without starting the transport client. |
| Document input, clipboard items/files and local file citation spelling | The same file exercises real file input and paste events, exact one-card-per-file behavior and file-citation target/location. Existing upload negotiation/refusal/recovery and Chrome/Edge download/resume cases keep transport/size authority; an old hard-coded size expression is not the policy. |
| Image Back/arrows, left-edge swipe, host viewport and Telegram method spelling | The same file uses viewer keys and the public Back API, canceled/middle/vertical/edge gestures with retained draft, real rendered viewport versus a different host width, and a synthetic Telegram host port. Android native forwarding is not executed by these browser cases; its old source string was not an executable Android proof. |
| Older-page private helper and cursor regexes | The view case distinguishes short/canceled/released/in-flight/hidden-pane pulls and button intent. `active-history-projection-dom.test.mjs` runs the complete transport client: a cursor-crossing reply is refused; a valid exact page prepends unique IDs without moving the reader. The existing 25-turn durable-question oracle is preserved. |
| Shared-composer header, diff/settings and Sync `askText` signatures | Public DOM cases activate diff for the exact Stream, open/close Stream settings independently of general settings, and complete nickname/enrollment/invite through the real shared dialog. No native browser prompt may occur. |
| Grouped Claude and recursive child source strings | The view case runs actual journal recomposition: latest content stays open, earlier and two nested child disclosures open independently, and Collapse All closes them. The generated VS Code journal case separately retains recreation/empty-state coverage. |
| Journal grouping/pagination/title helper spelling | `journal-view-controller.test.mjs` checks stable Workspace/Stream/Claude identities, compact grouping and distinct root/child identity. `journal-virtual-ui.test.mjs` checks current grouped DOM, bounded on-demand cursor requests and exact identity across overlapping pages. Mobile linked titles retain a link without acquiring another expansion action. |
| Dispatching/deferred source duplicate and legacy Project-renderer absence | Existing `managed queue omits unsolicited caption and preserves user content and actionable states`, `production queue corrects stale idle placement and survives receipt eviction` and the canonical-state client cases retain delivery/queue authority. Maintained catalog/navigation cases use stable Workspace/Stream/Thread identity; absence of a private legacy function adds no contract. |
| Journal traversal/source-order spelling | Retired implementation-shape duplicates do not assert an algorithm through function names. Current grouping/recreation/identity and observed trace/DOM requirements remain executable. These checks do not claim proof that every possible body-wide scan is absent, or a production journal latency bound. |
| Backend function-name assertions in the UI lifecycle suite | The existing provider service tests exercise disabled/enabled cleanup with the exact Thread/turn/item; provider event tests exercise a lost separate completion event and an unregistered completed compaction. These preserve real leaf requirements. Neither these cases nor the retired source strings prove the whole application `isMaintenanceActive` registration; no new whole-composition coverage is claimed. Backend production is unchanged. |

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
selection I/O from render work. `history-page-apply` records synchronous history
application under the original navigation trace ID; the subsequent paint keeps
its own visible-opportunity duration. A cold independent history read skips
snapshot application while its selection reply is still held; that stage is
reported as inapplicable rather than assigned a fabricated zero. Transport
spans include waiting and are not CPU-work measurements. Its synthetic Desktop/SQLite measurements are
not production selection latency or a production SLO. Production mixed
`ui-render` percentiles remain separately attributed, without inferring a
selection duration or a cause from them.

Use named failed/affected cases after a correction. Do not rerun the full release
suite, the expensive long final-history cases or a browser matrix with unchanged
inputs solely to produce a new aggregate. Runtime installation, release
membership and original user-window acceptance belong to their normal owners.

## CORE correction boundary

The independent review of `fa04` returned the remaining CORE source-form gap.
The correction retires 24 source-only cases and the current-dialog implementation
clause in a mixed settings/statistics case. Unrelated theme/statistics assertions
are unchanged. The three production modules remain byte-for-byte `fa04`; this
correction adds view/transport behavior coverage and removes source duplicates.

New view cases use the app's public projection APIs with its transport client
absent. Real history protocol/cursor checks use the complete client separately.
Fixture setup failures are retained: the pull began before scroll restoration
settled, the diff test initially expected the wrong public event field, and the
Sync waiter initially assumed a button label changed after enrollment. These
are corrected without extending timeouts. A synthetic journal's compact rows
can overlap; nested native disclosures are exercised through focus and Enter,
without forced pointer clicks or changing production layout.
