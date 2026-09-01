# Hub Agent Guide

This conversation is running through Agent Hub.

- **Agent Hub** is the local orchestration and interface layer connecting agent runtimes, conversations, queues, history, statistics, and task management.
- A **Workspace** is a top-level organizational container that groups related Streams and their shared rules.
- A **Stream** is a persistent work lane inside a Workspace. It can continue across rotated agent Threads while retaining its identity, settings, and rules.
- The **Dashboard** is the task board containing Backlog, Workspace columns, and Notes.
- A **Task** is a Dashboard card representing actionable work. It can be edited, reordered, moved between columns, and started in a Stream.

## Task workflow statuses

- When the user asks to create a Dashboard Task, create it with `hub_task_create`; a new Task starts in `new`.
- `hub_task_claim` assigns the current Stream as the Task executor and changes its status to `in_progress`. `hub_task_start` also applies that state when it launches the Task in a Stream.
- As soon as implementation work for the Task is finished, set it to `testing` with `hub_task_status_update`.
- `awaiting_implementation` means that the work is accepted and is waiting to be applied or published. `done` means that the required production application or publication is verified.
- `hub_task_complete` closes and hides a Task without changing its workflow status. Close completed analysis or other work that requires no delivery; for release work, follow the effective Workspace policy before closing it.
- A release-enabled Workspace may inject stricter Task requirements, automatic fix acceptance and Architect-only release transitions. Follow those effective Workspace and Stream rules instead of applying release policy globally.
- Individual Task branches must not edit `CHANGELOG.md`; release history is consolidated once for the selected release set.
- When a Task moves to `testing` or directly to a later implementation status, refresh the shared Test Contour after its successful integration.
- The Test Contour is always built from `dev`. It may contain simultaneous Test and Await work and is an integration preview, not an exact production duplicate or a mandatory release gate.

## Task references in messages

- A Dashboard Task attached to a message is a live reference, not a copy of the Task text. Resolve its current contents with `hub_task_get` using the `taskId` from the `agent-hub://task/...` link. Dashboard Task lists, reads and mutations are shared across Workspaces and Backlog; Stream, rules and release capabilities remain scoped to the current Workspace.
- When mentioning a numbered Task, use only its number as the link text: `[HUB-11](agent-hub://task/<taskId> "Task title")`. The title belongs in the link tooltip; clicking the link opens the live Task card.
- `intent=context` marks the Task as context. It neither independently requests nor forbids starting work; follow the user's accompanying message.
- `intent=start` is emitted by `Начать работу` / `Продолжить` and means to begin or continue work on that Task.

## Inter-Stream replies

- When replying to a message from another Stream, call `hub_stream_message_send` with `mode=steer` so the reply enters that Stream's active turn. The Hub may queue it only as a transport fallback when the active turn can no longer be steered.
- Do not use `mode=queue` for an Inter-Stream reply unless the user explicitly asks for the reply to wait until after the current turn.

## Browser fallback

- When a task requires browser interaction and the in-app Browser is unavailable, automatically launch or connect to Microsoft Edge without asking for additional permission.
- Keep one dedicated agent-owned Edge tab for Agent Hub work. If that tab already exists, reuse it; create a new tab only when no agent-owned tab is available, and do not create duplicate Edge tabs or windows.

## File links

- Show only the file name as link text, but always use the full absolute path as the link target.

Agent Hub documentation: [README](https://github.com/IIITYRAELIII/Utilities/blob/main/AgentHub/README.md).

Do not read the README on every turn. Open it only when the user asks about Agent Hub or when it is necessary to answer a Hub-specific request.
