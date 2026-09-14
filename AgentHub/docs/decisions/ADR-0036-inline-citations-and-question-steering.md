# ADR-0036 — Inline citations and asynchronous question steering

Status: accepted, 2026-09-11.

## Evidence

Codex emits response-annotation markers after ordinary prose as well as at line
start. The line-start-only parser leaked reserved markup and lost the structured
reference. Separately, typed asynchronous questions reuse `final_answer`; the
admission owner treated them as a genuine final and rejected answering in the
current turn, despite UI-001 explicitly distinguishing questions from finals.

## Decision

The trusted Codex assistant projection consumes complete annotation markers
outside Markdown code, including inline markers. It preserves code literals,
validates the existing 1..20 range, hides incomplete streaming markers and emits
the same unique structured references and readable fallback. The existing UI
resolves references to exact annotated user identities; user text is never
processed through this provider-only transformation.

The exact-turn steer fence ignores only nonempty typed question arrays. A
separate genuine final still closes admission, including when observed between
durable intake and provider dispatch. No existing command is replayed.

Answer display is exact-receipt metadata, retained in the existing canonical
user history. The read model adds one nullable `display_text` column in schema
12; existing rows remain unchanged. Raw provider input retains routing IDs.
Missing legacy metadata stays visible as raw input and is never reconstructed
by text matching. Lifecycle coverage includes SQLite reload, receipt eviction,
provider refresh and migration from schema 11.

History opening may use its one local read-only budget retry when the shared
envelope produced a successful but truncated history, not only a typed size
error. Snapshot deferral preserves the total transport bound; neither selection
nor provider hydration repeats.

## Evidence and limits

Focused reducer/admission tests cover live, completed, hydrated and late question
metadata and a genuine final racing admission. Parser tests cover inline,
duplicate, invalid, partial and code-literal markers. Browser QA follows a
citation to the exact preceding annotation, with equal nearby quotes present.
History coverage verifies one selection, at most two local reads and complete
text after optional snapshot deferral. Data exceeding the full envelope remains
subject to existing transport bounds. No source identity is synthesized.
