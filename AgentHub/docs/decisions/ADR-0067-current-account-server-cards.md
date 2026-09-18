# ADR-0067 — Current account on Server cards

Status: accepted

The user requested the current account instead of last-login-attempt labels.
The Server cards now show email when provided, an explicit authentication method
for API credentials, signed-out only on provider confirmation, and unknown when
the account cannot be determined. Pending/cancelled/failed login state remains a
separate line, with the existing local link/code ownership unchanged.

ProviderLoginService keeps an ephemeral display projection, sourced from Codex
account/read and Claude auth status --json through the configured invocation.
No credential files are parsed for this UI. Snapshot reads are nonblocking;
per-provider in-flight reads coalesce and refresh after 30 seconds of snapshot
access. Account changes invalidate in-flight generations; stale results cannot
replace a newer account. Failed reads clear stale identity and return unknown.
CLI/RPC calls have a five-second bound; login confirmation retains its prior
15-second bound. No background timer, auth mutation or new persistent owner.

Only display state, bounded email and allowlisted method reach shared snapshots.
Usage attribution, historic account identity and active turns remain unchanged.
No authentication test or logout is required to validate this display change.
