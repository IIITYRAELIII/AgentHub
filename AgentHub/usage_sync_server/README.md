# Agent Hub usage sync server

Minimal Python service for synchronizing Agent Hub usage snapshots through a
small VDS. It is intentionally not wired into systemd or nginx by this
directory.

Commands:

```bash
python agenthub_usage_sync_server.py --db usage-sync.db init-db
python agenthub_usage_sync_server.py --db usage-sync.db create-code
python agenthub_usage_sync_server.py --db usage-sync.db serve --host 127.0.0.1 --port 9198
```

Public endpoints:

- `GET /health`
- `POST /api/enroll`
- `POST /api/enrollment-code`
- `POST /api/usage`
- `POST /api/snapshot`
- `POST /api/changes`

`/api/usage` verifies `X-AgentHub-Device-Id` and `X-AgentHub-Signature` against
the enrolled Ed25519 public key, then upserts only events owned by that device.
`/api/snapshot` uses the same headers and returns the shared pseudonymized
snapshot for import on another Agent Hub installation.
`/api/changes` uses the same headers and returns records with
`server_revision > sinceRevision`; old clients may keep using `/api/snapshot`.
`/api/enrollment-code` also uses the same signed headers and returns a new
one-time enrollment code; only an already enrolled device can create it.

Push, snapshot and changes responses include `usageFactSchemaVersion`,
`datasetGeneration` and `serverRevision`. Full snapshot and `summaryOnly`
responses also include a deterministic `factSummary` over the complete
normalized fact set. Clients bind their pull cursor to the server generation and
local store generation, and run a full reconciliation when that tuple is missing
or changes. A request body with `summaryOnly: true` returns the same metadata
with `events: []` for bounded anti-entropy checks.

Local Agent Hub client flow:

```bash
npm run work-log:usage-sync -- identity
npm run work-log:usage-sync -- invite
npm run work-log:usage-sync -- enroll --server https://sync.example.test --code <one-time-code>
npm run work-log:usage-sync -- sync --project
```

`enroll` stores only the server URL, local device id and timestamps in
`usage-sync-remote.json`. The Ed25519 private key stays in the local
`usage-sync-identity.json` file and is only used to sign enrollment, push and
pull request bytes.
