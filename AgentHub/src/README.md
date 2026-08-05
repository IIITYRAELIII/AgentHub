# Internal source layout

`src` contains internal Agent Hub modules grouped by architectural role. Stable
entrypoints, compatibility shims, release scripts and public CLI modules remain
at the `AgentHub` root so existing launchers and integrations do not change.

The target layout is:

- `application` — use cases and state owners coordinating domain and ports;
- `domain` — provider-independent entities, value objects and invariants;
- `providers/codex` and `providers/claude` — provider adapters;
- `interfaces/telegram` and `interfaces/desktop` — client transports and controllers;
- `runtime` — process lifecycle, restart, timers and background jobs;
- `infrastructure` — filesystem, SQLite, network and operating-system adapters.

Migration is incremental. A module moves only together with its imports and
contract tests; moving files without establishing a responsibility boundary is
not an architectural stage. Internal modules must not import the composition
root `agent-hub-server.mjs`. Prefer direct imports over barrel files so cycles
remain visible to the architecture checks.

New application state must use stable task references and prefer `hubTaskId`.
Provider thread/session IDs are external references and must not become the
permanent identity of a logical task.

Run orchestration is split by responsibility: `RunCoordinator` serializes one
logical-task lane and dispatches provider operations; `ManagedRunLifecycleService`
owns managed-run registration/finalization; `DeferredInputStore` owns pending and
queued input state; `RunRecoveryCoordinator` restores managed and observed runs;
`RunConflictPolicy` owns the optional repository-write guard. None of these
services derives logical identity from a single provider thread/session ID.

Provider implementations are complete directory-owned slices. Codex process,
transport, hooks, snapshots, accounting and terminal services live under
`providers/codex`; Claude invocation, detached stream I/O, launch, snapshots and
work-log accounting live under `providers/claude`. Application and interface
modules receive provider-specific parsing/import functions through composition
instead of importing concrete adapters across the dependency boundary.

The enforced dependency direction is:

- `domain` → `domain`;
- `ports` → `domain`, `ports`;
- `application` → `domain`, `ports`, `application`;
- `providers` → `domain`, `ports`, `application`, `providers`;
- `interfaces` → `domain`, `ports`, `application`, `interfaces`;
- `runtime` → `domain`, `ports`, `application`, `runtime`;
- `infrastructure` → `domain`, `ports`, `infrastructure`;
- `composition` may bind every layer.

Temporary dependencies on frozen legacy root modules are allowed only while the
module is listed in `architecture-migration-inventory.json`. The architecture
test rejects every unregistered root module and every dependency that points in
the opposite direction.
