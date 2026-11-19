# ADR-HUB-458: Existing timing for release continuation

Status: proposed

Generation-zero amendment admission and first-compose recovery can do substantial
prepared-source validation before a durable amendment or generation is returned.
The ordinary compose trace does not cover its sibling recovery callback.

Use the existing Task operation timing context at the public continuation call,
selection amendment, first-compose recovery and test-plan resolution. The trace
operation ID is the original command request ID; releaseOperationId separately
identifies its retained release. Recovery carries the selected generation,
process ID and available owner epoch. Each invocation retains its own trace ID.
The existing bounded sink, Git aggregates and lock wait/acquisition events apply.

First-generation inspection, final prepared reread, amendment commit and outer
command receipt have separate spans. The public command end observes the server
receipt/result boundary, not network delivery or client rendering. Existing
success and refusal paths keep their real results; failure still closes and
flushes the same timing context. No file bodies, error messages, argv or secrets
are diagnostic metadata. Other operation types retain their current identities.

These measurements confer no admission, publication, retry or no-effect
authority. They do not alter release validation, locks, SQL/CAS, Git, selection,
frozen generations or deadlines. No cache, second tracer or automatic test
selection is introduced. The historical long continuation's internal cause
remains unknown until measurements from the actual delivered owner support it.

Validation uses a disposable real prepared Git/freeze owner and SQLite public
MCP route. Synthetic accepted Task evidence and validation/publication ports are
explicit fixture boundaries. A held real Await lock exposes waiting separately
from protected work. Ordinary compose, recovery, inventory, failure and durable
timing readback are checked without a production release.
