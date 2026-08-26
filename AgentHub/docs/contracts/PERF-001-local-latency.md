# PERF-001 — Local command latency

## Trace contract

The root trace identity is the command ID. Required stages are client submit,
transport start, Hub receive, receipt lock wait, durable intake enqueue/start/
commit, response send, client ACK, dispatch, admission, provider RPC/accept,
first event/content/visible, terminal commit and projection visibility.

Cross-process timestamps use UTC epoch; durations inside one process use a
monotonic clock. Every blocking span reports outcome, queue depth and relevant
lock or SQLite wait.

## Initial local SLO

- Durable ACK without attachments: p50 <= 75 ms, p95 <= 250 ms, p99 <= 1 s.
- Intake writer start to commit: p95 <= 100 ms, p99 <= 500 ms.
- Idle committed command to dispatch: p95 <= 250 ms, p99 <= 1 s.
- Durable ACK to local projection visibility: p95 <= 1 s, p99 <= 3 s.
- Correctness: no duplicate effect on same-ID retry and no lost ACKed command.

When a ready VS Code direct HTTP transport does not confirm `send-message`
within 250 ms, the WebView starts the authenticated IPC path with the same
`clientUserMessageId`. The first successful receipt wins; the durable message
ledger must collapse the other transport into the same command effect.

Background history hydration may use at most two concurrent HTTP requests per
client. User commands, snapshots and attachment reads do not enter that queue.
The VS Code WebView does not open a direct `/events` stream: journal changes are
already delivered by the extension subscription, so a retained panel cannot
consume a long-lived Chromium HTTP socket for duplicate notifications.

The “Local Hub” health RTT is not message ACK latency and must not be presented
as such. Provider latency and remote Worker latency are separate indicators.
