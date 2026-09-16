# ADR-0053 — Optional Task test environments

Date: 2026-09-15
Status: Accepted
Contract: REL-001

## Decision

Keep the agreed validation guidance in the release workflow checkbox rules.
Use branch-local automated checks by default. Use a test environment only when
the Workspace provides it and the verification requires a running application
or user inspection. Temporary isolated Task environments are optional and
require Workspace support. Do not require a permanent environment for each Task.

Shared environments check combined work. Reuse the required ready version. If
the project provides a shared-environment lock, acquire it only immediately
before testing after checking that exact version, then release it on success,
failure or cancellation. Do not hold it during coding, fixes, local tests,
review or waiting for another agent or person. ADR-0064 supersedes the earlier
coordination wording with this concrete optional lock lifecycle.
Workspace rules define commands and readiness; release validation remains
mandatory. No skill or additional live Workspace/Stream rule block is added.

## Scope and compatibility

This remains conditional agent workflow policy for arbitrary Workspaces. Agent
HUB additionally provides the concrete manual lock described in ADR-0064 for its
single rolling dev contour. Exact preflight checks remain unchanged. Generated
prefix replacement recognizes the previous exact policy; authored rule edits
remain untouched. This compatibility entry can be removed when supported stored
rules no longer contain that generated prefix.
