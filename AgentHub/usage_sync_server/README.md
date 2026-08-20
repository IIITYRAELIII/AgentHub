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
- `POST /api/usage`
- `POST /api/snapshot`

`/api/usage` verifies `X-AgentHub-Device-Id` and `X-AgentHub-Signature` against
the enrolled Ed25519 public key, then upserts only events owned by that device.
`/api/snapshot` uses the same headers and returns the shared pseudonymized
snapshot for import on another Agent Hub installation.

Local Agent Hub client flow:

```bash
npm run work-log:usage-sync -- identity
npm run work-log:usage-sync -- enroll --server https://sync.example.test --code <one-time-code>
npm run work-log:usage-sync -- sync --project
```

`enroll` stores only the server URL, local device id and timestamps in
`usage-sync-remote.json`. The Ed25519 private key stays in the local
`usage-sync-identity.json` file and is only used to sign enrollment, push and
pull request bytes.
