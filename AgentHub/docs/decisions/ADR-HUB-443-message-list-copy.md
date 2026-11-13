# Preserve ordered-list numbers in selected message copies

The user reported that selecting a rendered answer and using Ctrl+C lost list
numbers in a plain-text destination. An actual Edge keyboard copy/paste through
the maintained whole-client fixture reproduced that failure: the rendered list
started at seven, while the pasted text contained only item bodies.

## Decision

The message view projects the exact selected DOM range into clipboard text when
it contains ordered list items. Ordinals come from the original list's start,
direction, item values and sibling positions, not from a new list starting at
one. Only selected text is cloned; structural list prefixes and line boundaries
are added without adding unselected item bodies. A corresponding selected HTML
fragment retains explicit item values. The original message DOM is not changed.

The copy event listener acts only on a selection owned by one rendered chat
message and leaves editable controls and other selections to the browser. It
does not register a hotkey or access unrelated clipboard data. The existing
selection menu captures this same projection when opened. Annotation quote
content, UTF-16 source offsets and hashes retain their existing owner. The
whole-message copy action continues to copy canonical Markdown.

## Evidence

`tests/public/message-copy-selection.test.mjs` uses real Edge Ctrl+C and Ctrl+V
into an ordinary textarea, not a synthetic clipboard event or Selection.toString
as the clipboard oracle. It covers original starts, partial item boundaries,
nested semantic list DOM, explicit values, reversed lists and line breaks, plus
selection-menu/full-message behavior and native controls/outside selections.
Nested DOM coverage does not claim a new nested Markdown parser capability.
