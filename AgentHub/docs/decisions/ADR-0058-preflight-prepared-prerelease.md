# ADR-0058 — Preflight verifies prepared PreRelease

Date: 2026-09-16
Status: Accepted
Contracts: REL-001, MCP-001

## Decision

Await already prepares PreRelease. Release preflight therefore audits the existing
candidate instead of rebuilding it and refreshing a rolling dev-based contour.
Keep the reviewed-main approval and upstream adoption gates, current accepted
Task set, exact candidate manifest/checkout and primary preservation checks.
Reject missing or stale candidate evidence and unfinished Git/freeze operations.
Never turn a failed verification into an implicit repair or accept fresh origin
changes as a new base. Recheck candidate and plan before returning ready.

Return the prepared head/tree/manifest unchanged, including on repeated checks.
The later existing publication freeze owns version and changelog metadata and
must match the checked prepared head/plan. It is not duplicated in preflight.
The Workspace-prescribed pipeline remains the full final validation. Existing
repository-owned validation adapters continue to check the prepared candidate;
removing mandatory dev-contour refresh does not disable configured QA.

Unrelated Test work or an unavailable rolling contour cannot block preflight.
Ordinary contour commands and their readiness checks are unchanged. Non-release
Task transitions are unchanged. Legacy interrupted-preflight reconciliation stays
readback-only and must not infer success from candidate presence. Candidate base
selection during Await is a separate follow-up under HUB-235 point 11.
