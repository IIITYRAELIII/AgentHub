# Tyrael Integration Desktop — redesign

## Visual direction

- Dark, quiet workspace rather than a Telegram clone.
- Codex: cyan → mint (`#2CCBFF`, `#39E6C2`).
- Claude: amber → coral (`#F5B45B`, `#F17852`).
- Neutral base: ink (`#080C12`), panels (`#0E1621`, `#131E2B`), text (`#EAF2FA`).
- No emoji navigation, hexagonal decoration, oversized media banners, or fake glass effects.
- Provider colour is a state accent, not a full-card fill.

## Product layout

- [x] Compact navigation rail: tasks, activity, changes, settings.
- [x] Searchable task sidebar with active/recent grouping and runtime badges.
- [x] Conversation canvas with selectable Markdown-like message cards and live turn card.
- [x] Context inspector with agent/model/reasoning/mode/runtime/access controls.
- [x] Persistent composer with per-task drafts, annotation chips, image previews and send/queue state.

## Telegram parity

- [x] Agent, model, reasoning and Plan/Work selection.
- [x] Projects, task creation/selection/rename/archive.
- [x] Status, limits, current diff and task runtime.
- [x] Manual/automatic approvals and active approval decisions.
- [x] Stop, restart, queue/deferred-input decisions and TTS.
- [x] Codex and Claude parity where the underlying provider supports the operation.

## Desktop-native additions

- [x] Select assistant text → add an annotation with an optional comment.
- [x] Serialize annotations with the next prompt using the Codex response-annotations contract.
- [x] Paste or drop screenshots, preview/remove them, preserve them with the task draft.
- [x] Open local file links and copy code/text without routing through Telegram.
- [x] Preserve text, annotations and image attachments across task switches and restarts.

## Verification

- [x] Unit tests for approval decisions and the Desktop RPC boundary; process E2E covers the composed actions.
- [x] Desktop process E2E for settings, approvals, images, queue, cancel, status, rename and archive; shared restart E2E remains authoritative for the restart mechanism.
- [x] Native build plus visual smoke at normal and narrow-window layouts; WPF remains per-monitor DPI aware through the system runtime.
- [ ] Upgrade existing installation without losing current task drafts.
