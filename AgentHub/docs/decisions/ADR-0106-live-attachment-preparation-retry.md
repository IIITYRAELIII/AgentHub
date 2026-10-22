# ADR-0106 — Retain failed local preparation and use the begin receipt

Status: proposed for the screenshot-upload correction, 2026-10-16.

The first visible wait hashes and verifies a local Blob save. It does not upload
the file. The later upload prepares a server-owned attachment; remote-to-local
materialization and provider preparation remain separate owners. Missing traces
cannot prove that a historical incident transferred the same bytes twice.

The composer previously disposed temporary previews before inspecting batch
results, then discarded every successful sibling if one local read failed. The
existing preview collection now retains those Files, successful prepared records
and stable upload IDs. Explicit retry runs only failed preparation under the same
Task/destructive-operation fence. Removal releases the preview; retained Files
do not grant durable reload recovery or message admission.

The client uses the exact authenticated begin receipt instead of immediately
requesting the same state again. Existing/lost attempts still read status; absence,
expiry and same-ID recovery retain their existing rules. No server state owner,
automatic message resend or alternate recovery registry is introduced.

Preparation child spans use the original upload ID in the existing bounded
tracing mechanism. The first capability request also binds the message ID rather
than disappearing from the per-upload timeline. Publication must preserve the
reviewed browser assets and both local/Worker protocol owners together.
