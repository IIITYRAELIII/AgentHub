# ADR-HUB-427 — Read a cold chat independently of selection

Status pending independent review.

The current cold tab path awaits `open-task`. That service starts local history
and ordered selection together, then waits for both before returning history.
An available full request/final therefore waits behind a slow selection reply.
Read admission also waits because the canonical final has yet to render.

The client uses the existing addressed `task-history` and `select-task` owners
independently. It admits a first page through the existing navigation, current
binding, snapshot-generation and exact-final checks, preserving the newer global
snapshot. The ordered selection is still awaited and its failure is reported.
Its late reply crosses the same latest-navigation and current-Thread fences.

Cold selection requests a deferred snapshot from the selection owner. Binding
activation completes before its lightweight confirmation. The ordinary refresh
obtains the authoritative snapshot after confirmation. This avoids collecting a
global snapshot within the newly split selection call. Existing selection callers
keep their response contract unless they explicitly request deferral.

The canonical page retains its full messages and existing older-page cursor.
Read confirmation uses the existing account/provider/Thread/turn/revision owner
after rendered-final eligibility and paint. Retained-window, live-run, quote,
attachment, pending-command and terminal-revision behavior retain their owners.

The regression holds selection confirmation while a real SQLite read owner and
actual client/Edge DOM execute. Its ordinary and heavy cases verify full latest
request/final, both Ready markers, all loaded user messages and a newer navigation
before releasing the old selection. Mobile uses the current mobile stream list.
BEFORE/AFTER wall intervals include that deliberately held selection response.
CPU, heap and I/O counters state their process/surface attribution. Natural
installed timing and the user incident remain separately measured acceptance.
