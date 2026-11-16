# Transfer preparation and dialog identity regressions

Preparation is admitted through the existing owner HTTP endpoint with status 202.
An asynchronous copy failure belongs to that preparation: the existing store
records failed, managed partial files are removed, and quota stays charged until
canonical GC confirms deletion. The service observes its detached promise while
retaining the original rejecting promise for explicit waitForPreparation callers.
It must not invoke the process fatal-shutdown path for an ordinary copy failure.

Every dialog opening has a distinct context, even when reopening the same path.
Requests capture that context, the API handler and operation revision before
awaiting. Results can update the dialog or schedule its next action only while
that exact context/revision is current. Create keeps its original request ID,
TTL and artifact identity through an ambiguous response. Revoke confirmation
captures its own context and share ID. Closing invalidates projections and future
automatic actions; it does not cancel or rewrite an already admitted server
effect or its persisted receipt. Reopening reads canonical owner status.

Run the focused regressions with the ordinary test environment:

    node --test tests/infrastructure/file-transfer-background.test.mjs tests/public/file-transfer-owner-races.test.mjs

The background test uses an isolated child, actual HTTP/SQLite/service/fatal
handler and a gated synthetic EIO after 202. Event-loop beforeExit drainage occurs
before service.close can observe the promise, so the test cannot mask the defect
by awaiting the background work itself. Its optional waiter separately verifies
that EIO still reaches an explicit caller. The fatal handler has an isolated
shutdown port; no running Hub is affected.

Browser cases execute the shipped owner script in Edge, hold responses and close
and reopen through the rendered controls. Status, create, preparation, polling and
revoke responses are checked for both a different path and the same path. A late
revoke cannot close or disable a newer confirmation. Ambiguous create must reuse
its exact envelope. These are synthetic API/DOM tests, not public download,
physical mobile save or production cutover evidence. UI-001 projection identity
and the existing receipt/transfer owners remain unchanged.
