# ADR-HUB-470 — Recover retained accepted turns after App Server unload

## Evidence

Production 2.1.9 already contained the retained-UNKNOWN observer correction.
Repeated recovery-provider-read spans reached the existing owner with an exact
nonterminal active rollout snapshot, but fresh Thread metadata was `notLoaded`.
The idle-only eligibility condition refused every check. The fresh activity
resolver also classified `notLoaded` as UNKNOWN even with native absence.
A normal addressed
Stop reconciled that original and the same queued message was accepted.

## Decision

Extend the idle-only prerequisite of ADR-HUB-392 to `notLoaded` only when the
exact retained turn/snapshot has positive Hub ownership and matching canonical
provider acceptance. This permits entry into the existing cancellation owner
after the Thread read lane is released. It does not mean inactive or completed.
That owner still requires fresh provider/native inactivity, definite rejection
of the exact original interrupt, an exact snapshot, a second fresh inactivity
check, unchanged registry/turn identity and durable terminal persistence before
admission release. An accepted or ambiguous interrupt remains fenced.

The existing shared fresh activity resolver accepts `notLoaded` as a known
local Thread state, alongside idle/active. It still probes the exact rollout
uncached on Windows: a live holder is active, successful native absence plus
idle/notLoaded is inactive, and failed/missing native evidence is unknown.
Non-Windows and missing rollout paths remain unknown. This corrects the previous
idle-only test expectation explicitly. Admission consumers receive that same
activity result; none gains terminal authority or bypasses a retained run.

Active, unknown or error Thread metadata, foreign/missing acceptance and absent
or foreign snapshots do not acquire this eligibility. No new state owner,
timer, rollout rewrite, message identity or prompt replay is introduced.
The existing ordinary observer and startup recovery use the same path.

## Validation and delivery boundary

Behavioral regressions fail against the idle-only parent for both ordinary
observation after a newer turn and startup/reconciliation with retained exact
snapshots. The startup/reconciliation test also calls the real fresh activity
resolver with controlled native evidence, so an eligibility-only patch still
fails. Negative cases retain live/unknown activity, external/foreign or
unconfirmed acceptance, missing/foreign snapshots and accepted/ambiguous
interrupts. Existing replacement and durable-write failure tests still apply
to the unchanged cancellation owner. Source checks do not prove deployment.

Контракты: TURN-001, RST-001.
