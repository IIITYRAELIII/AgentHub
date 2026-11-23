# ADR-HUB-520 — Inline Codex visualizations

Status: Accepted
Contract: UI-001

The chat renders a standalone Codex visualize reference as an addressed
visualization at its position in the final answer. Ordinary Markdown, fenced
code and ordinary HTML attachments keep their existing render and download
semantics. The retained answer remains the original text.

The existing task-history control always resolves the source Thread from the
Stream catalog, then reads the exact terminal item and matching marker digest
from the Codex rollout in its existing worker. The browser supplies no file
path to the read operation. History and the live message model carry only the
reference text. The rollout and available artifact remain the sources on reopen.

New files may live in the Hub-owned attachments directory under
`visualizations/<Codex Thread ID>/<title>.html`. A direct child of the old
attachments directory is readable only with native successful creation in the
same turn and a modification time inside that turn. Canonical containment,
file identity, single-link and size checks apply to both. The legacy path is
read-only compatibility for older turns and only useful while those direct
files are present. Recording contours do not read captured production rollouts.

The chat loads a fixed sandboxed frame from its packaged assets. That shell
admits only the parent-provided data document in a separate opaque-origin frame.
The fragment's policy restricts network, frame, form, and object access, and
permits the skill's static resources and interactive script. The optional mode
and title are presentation hints only.
The Hub accepts only a bounded resize from the exact frame and discards bridge
messages originating in descendant frames. No persistence or follow-up API is
exposed to artifact code. An absent, out-of-budget or invalid source has the same
unavailable card. These reads never run as part of snapshot assembly.
