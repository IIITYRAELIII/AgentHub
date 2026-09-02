# MCP-001 — Bounded Agent Hub tool bridge

## Deadline ownership

The Codex MCP client owns a finite `agent_hub` tool deadline outside
`HubMcpServer`. It is longer than the server dispatch deadline, so ordinary
server timeouts keep their authoritative error, while a request stalled before
HTTP admission still terminates in bounded time. The deadline applies only to
`agent_hub`; unrelated long-running tools retain their own policy.

## Recovery and retry

A failed dynamic `functions.exec` call that contains an `agent_hub` MCP call
reloads the Codex MCP transport before a later attempt and wakes durable input
lanes. Read-only calls are safe to retry after that rebind.

Mutations are never inferred from text and never retried with a new identity.
They require the exact `request_id` and authoritative `hub_mcp_operations`
readback:

- no operation means pre-dispatch and permits a retry with the same id;
- `succeeded` or `failed` is terminal evidence and forbids another effect;
- `pending` is unknown and permits reconciliation only with the same id.

Logs contain tool and operation identity, status and recovery outcome, but not
the context capability or tool arguments.
