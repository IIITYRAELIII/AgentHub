# ADR-HUB-373 — Confirm the current live turn's progress

The current-process Codex observer receives `active`, while its uncertainty
guard and display reset checked `running`. A failed read therefore hid the live
card even after the same provider turn was visible again. This is reachable
through ordinary newly launched turn observation after ADR-HUB-476.

Use the provider snapshot's `active` contract. Only while the existing managed
run is uncertain, its ordinary read requests fresh native turn data and requires
that exact turn to remain `inProgress` alongside its exact nonterminal rollout.
A retained start marker, missing turn, interrupted projection or read error
cannot clear uncertainty. This replaces the lightweight read for that poll;
the existing transport requests only its latest turn page (one native turn),
never the default 200-turn history read. A different latest turn cannot adopt
or confirm the retained managed identity.
It adds no timer, discovery path or separate recovery service. Ordinary known
active polling keeps its lightweight read. Provider reads retain their existing
transport bounds; this is not a production latency improvement claim.

The controller captures run/provider/Stream/Thread/turn before yielding. A
changed identity, removed registry owner or terminal run rejects that result.
Native content received during that read keeps its existing item-reducer
revision guard; ongoing events cannot starve valid same-live confirmation.
Managed observation never
rebinds an accepted turn to another native turn. External observer behavior
retains its existing owner; this change does not create any external observer.

Desktop and browser projections consume the same corrected flag and retain
their terminal fences. No message, turn, receipt, admission or provider operation
is recreated. Previous-process local retirement remains absorbing, and startup
does not read or restore old execution. Historical initial UNKNOWN causality is
not inferred from the controlled reproduction.
