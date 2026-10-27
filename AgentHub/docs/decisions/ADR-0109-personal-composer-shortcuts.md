# ADR-0109 — Browser/WebView-local composer shortcuts

## Status

Minimal implementation for [HUB-113](agent-hub://task/2f6704ba-579f-4311-bdd6-81c1be9eeb8d "Настраиваемые сочетания клавиш поля ввода промпта").
Final Design consultation: ACCEPTED on 2026-10-15
(`design-hub113-factual-neutral-copy-accepted-20261015-v1`).
Earlier overbroad work is excluded from this change.

## Context

The existing composer already supports queue, steer and caret newline. A keyboard
preference only chooses one of these actions. It does not need a new admission,
provider, transport, persistence or authentication protocol.

## Decision

- Map Enter, Ctrl-only Enter and Shift-only Enter independently to queue, steer
  or newline. Repeated action assignments are valid.
- Defaults stay desktop Enter=queue and Ctrl/Shift+Enter=newline. Meta/Command
  and other chords retain existing behavior. Quote-comment keys are unchanged.
- Queue calls the existing submitComposer path; steer calls that same path with
  steerWhileRunning=true for both Codex and Claude. Existing backend fallback
  to queue or a new turn remains possible when an active turn is unavailable.
  No frozen run/turn identity or strict exact-steer promise is introduced.
- Store only the mapping in localStorage under agent-hub:composer-shortcuts:v1,
  following the existing client preference boundary. It belongs to this browser
  or WebView storage profile, not a server account. Users sharing that storage
  can share the preference; there is no per-user isolation or cross-device sync.
- Saving performs one atomic storage write. Failure keeps the modal draft and
  prior mapping. Cancel/discard does not save; restoring defaults is an editable
  draft until explicit save. Absent/malformed/unreadable storage uses defaults.
- Ctrl/Shift mappings precede slash selection; desktop bare Enter lets the open
  slash menu handle Enter first. IME/229 confirmation does not dispatch. Repeated
  send keydown cannot duplicate submission. Newline preserves caret/selection.
- Mobile bare Enter always remains native newline. Its disabled settings display
  shows the effective action without overwriting the saved desktop mapping.
  Hardware Ctrl/Shift use their mappings; the send button remains available.
- Shared Web assets supply Web, WebView and mobile. Existing asset discovery and
  WebView reference rewriting load the module without backend/extension changes.

## Consequences and verification

Only four frontend production files change. Existing receipt identity, draft
recovery, queue ownership, provider semantics and usage accounting are preserved.
Focused unit, settings DOM, production keyboard/transport-fixture and extension
render tests are the evidence. Fixtures do not run providers or a native VS Code
window. Final Design is ACCEPTED; release intake remains with Architect.
