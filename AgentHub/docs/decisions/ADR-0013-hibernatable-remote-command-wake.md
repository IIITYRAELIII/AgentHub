# ADR-0013 — Hibernatable remote command wake

## Decision

Replace permanent Durable Object long polls for the Mini App publisher and
Shared Dashboard bot with authenticated Hibernation WebSocket availability
hints. The hint is not a command or receipt. Each consumer performs an immediate
`waitMs: 0` durable pull on initial connection, reconnection and a new
availability revision. The Durable Object persists the command and wake revision
before notifying connected consumers.

During rolling deployment, an unavailable wake endpoint permits only a fixed
ten-second immediate-pull fallback. A Durable Object records successful wake
capability and then rejects nonzero waits on its service pull route. Existing
user-scoped result and snapshot waits remain unchanged.

## Consequences

- Idle service connections can hibernate and do not accrue Durable Object
  duration while waiting for commands.
- Durable queue claims and receipts remain the exactly-once effect boundary;
  duplicate or missed hints do not become another delivery authority.
- The fallback request and duration cost is deterministic and checked against
  the Free-plan daily quotas before deployment.
- Legacy permanent long polling remains only until the exact Durable Object has
  accepted the new capability; it is not a permanent compatibility path.
