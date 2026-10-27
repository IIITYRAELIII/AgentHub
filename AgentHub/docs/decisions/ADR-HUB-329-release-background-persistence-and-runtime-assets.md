# Release background persistence and runtime companion assets

## Context

A frozen publication installed a Codex custody module without its C# companion.
The explicit runtime asset inventory omitted the pair; the installed manifest
therefore consistently described an incomplete package. Separately, an automatic
release resume threw SQLite contention from a timer, and lease settlement could
reject the detached worker. Neither exception boundary contained that failure.
The foreign SQLite writer's identity is not established by these observations.

## Decision

The existing runtime packager includes the custody C# companion whenever its
JavaScript owner is present, checks its presence before preparing a runtime and
records its exact bytes in the existing runtime manifest. An older source without
that owner requires neither file. No installed immutable manifest is rewritten.

The release store exposes the existing asynchronous SQLite mutation queue scoped
to one original operation. Only short persistence closures enter it. Acquisition,
automatic resume and exact owner/epoch release retry contention within its bounded
budget, yielding between attempts with `busy_timeout=0`. Each attempt rereads CAS
and owner evidence. Publication, filesystem preparation and provider calls remain
outside SQL retry. No replacement request, operation, generation or publisher is
created. A stage encountering contention retains its durable receipt for ordinary
effect reconciliation instead of classifying database availability as a terminal
release failure.

Every detached worker and retry timer observes its rejection. Exhaustion reports
bounded operation/code diagnostics and defers to the existing retry timer; an
unexpected error is reported without an automatic new attempt. Lease settlement
always releases the process-local running marker; a deferred release retains the
exact original owner and epoch. Waiting recovery rereads the durable condition:
a cleared retry time or changed revision cannot be bypassed by the old timer.
No recovery hold, publication authorization or expected-runtime readiness check
is removed by this correction.

## Evidence and limits

Focused tests use real competing SQLite connections, original operation readback,
unchanged external effect counts, hold/exhaustion and unexpected-error controls.
The public runtime preparation test imports an installed disposable module that
actually reads its companion, checks manifest membership and rejects a missing
companion before a current pointer exists. This tests packaging, not execution of
the C# custody guard. It does not establish installation or successful cutover of
an already published generation; that remains with its canonical runtime owner.
