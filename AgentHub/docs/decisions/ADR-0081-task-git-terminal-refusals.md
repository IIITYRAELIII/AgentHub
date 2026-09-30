# ADR-0081: Task Git preparation and terminal validation refusals

A recorded Test operation took 97.420 seconds and failed ancestry validation
before changing dev. Its lifecycle was durably failed, but its MCP receipt
remained unknown. Later description edits prevented reconciliation because it
required the original Task revision even for this already failed operation.

Test delegates preparation to the snapshot owner once. Previous Test result
references are resolved against the canonical repository root, including when
the Workspace working directory is a subdirectory. First-parent merge parents
are read with one bounded Git log rather than one subprocess per merge. All
publication, adoption, lease, cleanliness and exact-result checks remain.

Explicit ancestry refusals carry a domain error. The lifecycle exposes a
terminal rejection only after reading back its matching durable failed record,
checking lease ownership and absence of a success outcome. Database failures,
lost leases and ambiguous Git effects remain unknown. Diagnostics identify the
offending Task and commit when available.

Reconciliation may settle an ordinary already failed operation after metadata
revision changes, provided Task identity, executor, workflow and Git references
still match its prior state. It changes only the original receipt and never
replays Git. Pending operations, successful outcomes, squash and cutover retain
their strict revision checks.

Validation covers durable failure versus failed persistence, exact receipt
replay, metadata edits versus changed workflow/executor/result, real Git
single preparation, nested-root result reuse, published ancestry, unpublished
fast-forward and exact adoption fences. An isolated current ancestry proof took
2.095 seconds / 46 commands; this does not attribute the historical 97 seconds
or establish a universal lifecycle latency bound.
