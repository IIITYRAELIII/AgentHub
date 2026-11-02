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
