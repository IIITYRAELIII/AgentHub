# Hub Agent Guide

This conversation is running through Agent Hub.

- **Agent Hub** is the local orchestration and interface layer connecting agent runtimes, conversations, queues, history, statistics, and task management.
- A **Workspace** is a top-level organizational container that groups related Streams and their shared rules.
- A **Stream** is a persistent work lane inside a Workspace. It can continue across rotated agent Threads while retaining its identity, settings, and rules.
- The **Dashboard** is the task board containing Backlog, Workspace columns, and Notes.
- A **Task** is a Dashboard card representing actionable work. It can be edited, reordered, moved between columns, and started in a Stream.

## Task workflow statuses

- When the user asks to create a Dashboard Task, create it with `hub_task_create`; a new Task starts in `new`.
- When work on a Task starts, its status is `in_progress`. Starting it through `hub_task_start` applies this status automatically.
- As soon as implementation work for the Task is finished, set it to `testing` with `hub_task_status_update`.
- When the user says that an analyst confirmed the result, set the Task to `awaiting_implementation`.
- When the user says the Task is done but does not say whether it is on the production database, set it to `awaiting_implementation` and ask whether it has been applied to production.
- When the user says the change was applied to production, set the workflow status to `done` with `hub_task_status_update`. `done` means ready on production; it remains visible and is not the same as closing the Task. Do not call `hub_task_complete` merely because implementation, testing, analyst confirmation, or production deployment finished.
- Close the Task with `hub_task_complete` only when the user explicitly says that the customer accepted it, that delivery/acceptance is not required, or explicitly asks to close it. Closing hides the Task from the current board.

## Task references in messages

- A Dashboard Task attached to a message is a live reference, not a copy of the Task text. Resolve its current contents with `hub_task_get` using the `taskId` from the `agent-hub://task/...` link. Dashboard Task lists, reads and mutations are shared across Workspaces and Backlog; Stream, rules and release capabilities remain scoped to the current Workspace.
- `intent=context` means the Task is context only. Do not begin work on it unless the user's accompanying message explicitly asks you to do so.
- `intent=start` is emitted by `Начать работу` / `Продолжить` and means to begin or continue work on that Task.

## Browser fallback

- When a task requires browser interaction and the in-app Browser is unavailable, automatically launch or connect to Microsoft Edge without asking for additional permission.
- Keep one dedicated agent-owned Edge tab for Agent Hub work. If that tab already exists, reuse it; create a new tab only when no agent-owned tab is available, and do not create duplicate Edge tabs or windows.

## File links

- Show only the file name as link text, but always use the full absolute path as the link target.

Agent Hub documentation: [README](https://github.com/IIITYRAELIII/Utilities/blob/main/AgentHub/README.md).

Do not read the README on every turn. Open it only when the user asks about Agent Hub or when it is necessary to answer a Hub-specific request.
