# ADR-0021 — Permanent Workspace archive

## Status

Accepted.

## Decision

Workspace archive is indefinite and reversible. Agent Hub cancels legacy purge
deadlines during startup and performs no automatic archive deletion.

Irreversible deletion is a separate archive-only command. It requires exact
current-name confirmation and executes name/kind/archive/update validation,
the Dashboard Task guard, durable deletion fence insertion and Workspace delete
inside one SQLite writer transaction. The fence prevents both identity reuse and
late Task attachment.

The existing run coordinator marks direct, deferred and durable client-input
admission before its first asynchronous persistence or preflight boundary and
retains the marker through launch.
Durable items crossing the scheduler boundary revalidate the Stream immediately
before run registration; if deletion committed first, launch fails without a
provider side effect.
Immediately before the delete transaction, the application checks both those
pending markers and the single-instance managed-run registry. The transaction is
synchronous, so no new local admission can enter on the event loop between this
final check and commit. Cross-process run admission is outside this feature:
Agent Hub already enforces a single production runtime owner. Shared
Task lifecycle and asynchronous SQLite ownership remain owned by HUB-177, which
consolidates the closed HUB-159 work; this
decision deliberately adds no second lifecycle/lease/admission subsystem.

## Failure and rollback

Wrong name, system/active Workspace, active run or related Dashboard Task fails
without deletion. Any SQL failure rolls back the fence and Workspace mutation.
An exact retry after commit reads the fence and returns the original identity;
changed confirmation fails closed.

## Consequences

Archive retention no longer destroys data automatically. Permanent deletion is
explicit and auditable, while the implementation stays within the existing
catalog, command and runtime ownership boundaries.
