# ADR-HUB-364: Review later selected automatic content explicitly

Date: 2026-10-29
Contracts: REL-001, SYS-001
Status: correction under focused verification and independent review

## Observed boundary

A cleanup result added a policy-literal test. A later selected release correction
deleted that exact case at the user's explicit request. Native Git automatically
retained the deletion while preserving cleanup implementation. Counterfactual
replay correctly required an explicit compatibility decision, but its obligation
bound only the cleanup result's earlier automatic entry. The existing exact
compatibility input could not represent the later selected automatic deletion.
Restoring the unwanted test or making a fake edit to trigger diff authority would
not implement the user's request.

## Decision

Keep every original Task/base/result, native prefix, failed receipt, review and
candidate immutable. Do not automatically excuse a replay obligation. Only when
its retained entry differs from its original automatic entry, derive the last
later selected result whose real native automatic merge changes the same path
from its preceding prefix. This also covers an explicit inherited addition's
removal when the final file happens to equal the immutable Task base. An unchanged
snapshot without the intervening source history does not change that prefix.
Include its immutable Task/base/result, preceding native prefix and real
automatic tree/entry in the existing complete obligation binding.

The existing independently authenticated compatibility review must explicitly
accept the obligation and match the complete binding. The retained mode/type/OID
or absence must equal the original or that later automatic entry. Another body,
an unrelated path, changed source/base/prefix/order or stale review still refuses.
Earlier successful bindings are unchanged: they already retained the original
automatic entry and receive no added fields. Undelivered compatibility updates
retain the original native review; prepared and historical readback rederive and
authenticate the same complete evidence.

No new public capability, ledger, writer, selection mechanism or publication owner
is introduced. The user-directed test deletion remains a loss of that coverage,
not a new claim about policy language or correctness. Focused real-Git evidence
must preserve cleanup bytes, refuse absent/stale authority, and reopen the exact
accepted candidate without restoring the deleted case.
