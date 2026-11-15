# Managed queue waiting and deferred-card actions

Status: accepted for source review, 2026-10-31.

The user reported "какого хуя!? ход тут идёт в хабе!" and explicitly requested
removal of "В новую задачу" from the deferred-message card. The coordinator
previously used `provider-thread-active` for both an exact registered managed
run and an external writer. The controller therefore applied its automatic
writer pause, while the UI incorrectly claimed another Codex and stopped
retries despite the controller scheduling occupancy rechecks.

The existing coordinator now distinguishes managed active/uncertain activity
from external occupancy. Ordinary queue remains after-turn, while explicit
steer keeps current-or-queue routing. The existing controller persists recovery
of a legacy automatic writer pause after positive current managed-run evidence;
it clears the automatic pause before setting the managed wait reason. This
avoids interpreting the new reason as an intentional pause after restart.
Manual pause wins across awaits and failed persistence restores prior state.
Positive normalized Hub execution ownership gates both classification and legacy
pause reclassification. Observed Hub-owned recovery is allowed; an observed
external run or missing/unrecognized owner is not silently promoted. Admission
uses the coordinator's classified reason without overriding it from activity
alone. Manually paused cards require explicit resume and make no automatic
delivery promise.
The migration is unnecessary once no persisted pre-correction automatic writer
pauses remain; it introduces no sweep, ledger, new timer or dispatch owner.

The web card removes only its new-Task button and its exclusive event handlers.
Other Task creation and provider/legacy service APIs remain intact. Correct
external-writer text acknowledges existing automatic rechecks without asserting
historical delivery or a performance improvement. Original IDs, annotations,
attachments, queue order, UNKNOWN reconciliation and cancellation are preserved.

Verification uses actual coordinator/admission/controller with SQLite reopen
and controlled provider ports, plus shipped-client DOM at desktop/mobile widths.
The reported six original comments are never replayed by tests. Production
installation and actual original receipt readback remain separate evidence.
