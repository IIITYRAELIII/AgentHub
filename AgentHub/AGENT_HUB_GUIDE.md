# Hub Agent Guide

This conversation is running through Agent Hub.

- **Agent Hub** is the local orchestration and interface layer connecting agent runtimes, conversations, queues, history, statistics, and task management.
- A **Workspace** is a top-level organizational container that groups related Streams and their shared rules.
- A **Stream** is a persistent work lane inside a Workspace. It can continue across rotated agent Threads while retaining its identity, settings, and rules.
- The **Dashboard** is the task board containing Backlog, Workspace columns, and Notes.
- A **Task** is a Dashboard card representing actionable work. It can be edited, reordered, moved between columns, and started in a Stream.

## Task workflow statuses

Reuse installed dependencies when the lockfile, runtime and platform requirements match; do not create a copy per Task. After successful transfer and verification, remove temporary Git bundles and copies through their owning cleanup mechanism; preserve unique work and required evidence.

- When the user asks to create a Dashboard Task, create it with `hub_task_create`; a new Task starts in `new`.
- `hub_task_claim` assigns the current Stream as the Task executor and changes its status to `in_progress`. `hub_task_start` also applies that state when it launches the Task in a Stream.
- As soon as implementation work for the Task is finished, set it to `testing` with `hub_task_status_update`.
- `awaiting_implementation` means that the work is accepted and is waiting to be applied or published. `done` means that the required production application or publication is verified.
- `hub_task_complete` closes and hides a Task without changing its workflow status. Close completed analysis or other work that requires no delivery; for release work, follow the effective Workspace policy before closing it.
- A release-enabled Workspace may inject stricter Task requirements, automatic fix acceptance and Release Manager-only release transitions. Follow those effective Workspace and Stream rules instead of applying release policy globally.
- Individual Task branches must not edit `CHANGELOG.md`; release history is consolidated once for the selected release set.
- When a Task moves to `testing` or directly to a later implementation status, refresh the shared Test Contour after its successful integration.
- The Test Contour is always built from `dev`. It may contain simultaneous Test and Await work and is an integration preview, not an exact production duplicate or a mandatory release gate.

## Closed Tasks are an archive

Closed Tasks and Tasks at workflow Done are archives. Read their evidence,
but do not reactivate or change them without the user's explicit request
to resume that exact Task. Check current state before acting.

Track new fixes in a separate Task linked to the archive.
Preserve the original result and history.

## Task references in messages

- A Dashboard Task attached to a message is a live reference, not a copy of the Task text. Resolve its current contents with `hub_task_get` using the `taskId` from the `agent-hub://task/...` link. Dashboard Task lists, reads and mutations are shared across Workspaces and Backlog; Stream, rules and release capabilities remain scoped to the current Workspace.
- Every Task mention in any message, including progress updates, final answers, status reports and Inter-Stream messages, must be a live link; never write a bare Task number or title. Use only the numbered Task as link text: `[HUB-11](agent-hub://task/<taskId> "Task title")`. Keep the title in the tooltip, and take the UUID from Task data; never guess it. Clicking the link opens the live Task card.
- `intent=context` marks the Task as context. It neither independently requests nor forbids starting work; follow the user's accompanying message.
- `intent=start` is emitted by `Начать работу` / `Продолжить` and means to begin or continue work on that Task.

When answering a comment from <response-annotations>, add :agent-annotation{index="N"}, where N is the item's 1-based index. This lets the user clearly see which comment you are answering.

## Inter-Stream interaction

- Send the requester and Team Lead one final report after completion and any required review: result, checks, and remaining limitations. Keep routine progress and technical details in the Task; do not send acknowledgments, repeated statuses, or review chatter.
- Executors and reviewers communicate directly. Do not copy the requester or relay their correspondence.
- Before the final report, contact the requester only when a specific decision is needed. State the blocker, evidence, and required decision; do not repeat the request without a material change. If blocked, report it honestly and end the turn. Do not bypass the blocker or claim completion.
- When auto-review is enabled or review is explicitly required, choose an eligible Workspace reviewer and contact them directly. Do not use the requester as a review dispatcher.
- Address findings and return corrections to the same reviewer. Approval does not replace user acceptance or publication.
- After requesting review, continue independent work if available; otherwise end the turn. Do not poll the reviewer unnecessarily.
- Send Inter-Stream replies through `hub_stream_message_send` with `mode=steer`. The Hub may queue them when steering is unavailable. Use `mode=queue` for replies only when the user explicitly requests delivery after the current turn.

## Browser in Hub

- Use Microsoft Edge through Playwright for website interaction. The user explicitly authorizes this browser automation method; no additional permission is required.
- Do not use OpenAI's built-in browser or the `browser` / `unified-computer-use` plugins, including `cua_repl`.
- Reuse an available agent-owned Edge tab. Create one only when needed; do not create duplicate tabs or windows.

## File links

- Show only the file name as link text, but always use the full absolute path as the link target.

Agent Hub documentation: [README](https://github.com/IIITYRAELIII/AgentHub/blob/main/AgentHub/README.md).

Do not read the README on every turn. Open it only when the user asks about Agent Hub or when it is necessary to answer a Hub-specific request.
