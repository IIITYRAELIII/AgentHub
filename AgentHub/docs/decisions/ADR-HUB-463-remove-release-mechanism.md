# ADR-HUB-463 — Remove release orchestration, retain Tasks and installation

Status: accepted by the user's explicit replacement request, 2026-11-17.

The existing release mechanism is removed in full: release operation/generation,
freeze/recovery/publication orchestration, workers/autoresume and release-only
MCP/HTTP/CLI/UI surfaces. A new releaser will be designed separately later.

Shared Task owners are separated as TaskIntegrationService,
TaskCompositionPlanService and TaskIntegrationGitService. Their actual native
Git/selected-content/authority/CAS behavior remains; removing a release facade
does not authorize skipping a Task guard. Task historical publication proof is
a read-only compatibility decoder, with no release writer or worker. Existing
SQLite/history/branches/user-authored instructions are preserved.

Independent build/ZIP/installer, maintenance and RuntimeHost ownership stay.
Runtime-manager delegates only the build primitive to the pinned external
runtime builder, never to a recipe executor. Installation locks and runtime
identity/retention are still needed and remain under their existing owners.

The delivery owner integrates the reviewed result into the existing PreRelease,
sets one version/notes entry, builds and installs 2.1.7 from its installer, checks
the installed application, then manually merges the verified result into main
and pushes. The deleted release pipeline does not deliver its own removal.

REL-001 is the current Task integration contract. Earlier release ADRs/archived
records remain historical evidence only. MCP-001 and RST-001 retain Task and
maintenance invariants while their obsolete release entrypoints are retired.
