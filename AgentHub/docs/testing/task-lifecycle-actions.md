# Task archive and deletion actions

The shared Task card separates launch/destination controls from the
“Действия с карточкой” group. Archiving retains the Task; deletion requires an
explicit modal confirmation with the full title and the alternative archive
action. Backend cleanup previews and their exact tokens remain mandatory.

The delete modal stays open until the original command settles. Pending locks
both confirmation controls and prevents dismissal/double submission. Failure is
an inline alert with safe focus; cancellation restores the delete opener.
Successful removal restores focus to the next Task, previous Task, then the
column heading. The conversation Task rail keeps its own focus destination.
Success is announced only after the existing canonical command owner succeeds.

The scoped danger alias derives red hue from existing semantic color tokens;
the label mixes in the semantic text color for contrast. It does not change the
global palette, launch accent, archive styling or standard focus color.

## Checks

Run from the application directory:

```sh
node --test --test-concurrency=1 tests/public/task-lifecycle-actions-dom.test.mjs tests/public/task-delete-dialog.test.mjs tests/public/task-cleanup-production.test.mjs
node --test --test-name-pattern="архив и удаление" tests/public/card-layout-dom.test.mjs
node --test --test-concurrency=1 tests/public/task-card-sizing.test.mjs tests/public/task-board-attachments.test.mjs tests/public/task-board-completed-filter.test.mjs tests/public/task-operation-not-admitted-dom.test.mjs tests/public/task-operation-submission-dom.test.mjs tests/public/task-operation-interruption-dom.test.mjs
```

The DOM suite runs shipped HTML/CSS/client code in Microsoft Edge with isolated
fixture data, actual Web HTTP and WebView bridge controls. It covers desktop
1280, narrow WebView 390/520, Mobile Web 320/390/430, Nebula/Orange, short height,
text enlargement, keyboard trapping/return, explicit confirmation, pending,
failure, cleanup cancellation, archive/delete routing, live feedback and focus
after removal. Captures and computed geometry/contrast are generated under the
ignored `WIP/task-lifecycle-captures/` directory.

This is fixture coverage, not a production mutation, native VS Code installation
test, manual screen-reader review or full accessibility certification.
UI-001 canonical Task outcomes, SYS-002 retained archive ownership and REL-001
original command/cleanup authority are preserved. No backend or transport
protocol is replaced.

## Git cleanup confirmation

The server cleanup preview is a separate mandatory confirmation. Its shared
dialog uses the canonical delete-dialog shell with an explicit operation scope:
archiving has an ordinary accent confirmation; deletion retains the local
danger treatment. Russian summary and Git consequences stay visible outside a
collapsed technical disclosure. The helper depends on the server's actual
deletion list. Raw paths, hashes, branch names, unknown kinds and the optional
server warning remain available in that disclosure with Russian labels.
The cleanup token is not displayed.

Confirmation locks the modal while its single original request is pending.
Failure leaves the server error visible with safe cancellation and does not
create an implicit retry. Custom confirmation adapters retain the same exact
request/token contract.

Run the focused corrective matrix with:

```sh
node --test --test-concurrency=1 tests/public/task-cleanup-dialog-dom.test.mjs tests/public/task-cleanup-production.test.mjs tests/public/task-delete-dialog.test.mjs
```

The matrix covers both actions on Web 1280, WebView 390/520 and Mobile Web
320/390/430 in Nebula/Orange, including focus, hover, pending, expanded technical
data, cancellation, errors, short height and enlarged text. Every run creates
its own mutable directory under ignored `WIP/cleanup-dialog-runs/`. Review
bundles are copied to a separate frozen directory; subsequent test executions
never write into that bundle.
