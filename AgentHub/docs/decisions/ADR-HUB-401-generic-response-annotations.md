# Generic response annotation aliases

Status: accepted implementation proposal for independent review.

The primary response marker is `:agent-annotation{index="N"}`. The existing
Codex marker remains a compatibility alias for retained and new responses;
there is no planned removal while supported histories contain it. Both aliases
refer to the same 1-based annotation index, not separate references.

The existing domain parser remains the sole owner. Existing exported Codex API
names remain compatible. Trusted Claude assistant projections use that same
parser at live snapshot, observed transcript, history, progress and completion
boundaries. Claude's raw streaming accumulator remains unchanged so a marker
split across events can be completed without losing its bytes. Reprojection
preserves normalized supplied references without parsing user prompts, titles
or user-authored content. Markdown code and escaping retain their literal text.

The canonical observed-run owner carries the reader's structured references
through creation, observer refresh and managed active snapshot application;
already projected answer text cannot reconstruct that mapping. A present new
answer replaces its normalized mapping, an explicit empty answer clears it,
and a metadata-only observation preserves it. A conflicting explicit turn
cannot adopt the mapping or retain stale references on the current run. Raw
stream accumulation and existing run/provider/registry identity fences remain
unchanged. Provider-specific no-op snapshot adapters are not metadata owners.

The canonical Guide contains the user's short English agent-marker rule and
the independently approved short archive paragraph. No effective Workspace,
global or Stream rules are written back. Intake source-locator creation is a
separate existing Task; this change does not relax identity, range or hashes.

Affected contracts: UI-001, MSG-001, TURN-001. Command identities, queue/steer
semantics, source locators and terminal revision/delivery owners are unchanged.
Evidence: alias/legacy/mixed/partial/code behavioral cases; actual Codex reducer
and terminal JSONL; Claude transcript/event surfaces; managed history and
notification restore; canonical Guide store/instruction composition; real
desktop/mobile DOM links to exact source locators. No live provider effects.
## Positioned citations and Task workflow guidance

The shared assistant parser now retains the exact first occurrence of each
annotation marker as an additive `position: {start, end}` on the existing
reference. Coordinates address the readable fallback label in LF-normalized,
boundary-trimmed projected text, matching the established live/history text
normalization. They do not address user/source content and never change the
source locator, range or hashes. Both aliases share the same deduplication and
code/escape/partial-stream parser. Existing normalizers carry this bounded
metadata through observed snapshots, completion, SQLite and Desktop history.

The renderer validates exact coordinates and fallback text, then interleaves
the existing citation control at that position. It does not sort citations by
index or search for a matching paragraph. Legacy records without coordinates
keep their explicit citation list; trusted retained originals acquire positions
only when the existing history owner reparses them. This compatibility path can
be removed when such retained projections have expired or been reprojected.
Unavailable originals are not rewritten and do not gain invented positions.

The canonical Task workflow section also receives only the two user-approved
English sentences about matching installed dependencies and owning cleanup of
verified temporary transfers. This changes guidance, not dependency management
or cleanup behavior. The earlier marker rule and short Closed Tasks text remain.
