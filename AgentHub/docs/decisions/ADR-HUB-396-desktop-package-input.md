# ADR-HUB-396 — Exact package input across DesktopControl

## Context

The public 2.1.3 recipient completed download and extraction, but its authenticated
`restart-package` command failed with "Package restart requires only its exact
original and public asset paths". DesktopControlRouter added `maxResponseBytes`
to every action. The application route forwarded those six keys to
RestartRequestService.fromPackage, whose strict five-key packageRestartInput
correctly refused before package preparation and maintenance-original creation.
This is a transport/business boundary defect, not a download or timeout defect.

## Decision

For `restart-package` only, the existing router forwards a fresh object with
exactly the caller's fields. It applies no presentation defaults and strips no
caller keys. The existing package owner remains responsible for the exact five
business fields and rejects every unknown field, including explicitly supplied
response-budget or tracing fields. Other actions retain their response policies.

Authentication and local privilege run before dispatch. The existing durable
package-command fingerprint includes all supplied caller fields, including
forbidden tracing keys: a changed request cannot return a prior cached success
before strict owner validation. The ordinary tracing-field exemption remains
unchanged for every other action. Valid unchanged five-key fingerprints,
same-command replay and package-original binding retain their existing meaning;
old fingerprints, rows and UNKNOWN outcomes are never rewritten.
Package verification/preparation, active work, stopping, persistence and actual
backup/replacement/readiness remain under their existing owners. No new API,
allowlist, receipt, retry, timeout or lifecycle authority is introduced.

## Evidence and operational boundary

The maintained regression uses a real authenticated DesktopControl server/client,
the real application/control routers, RestartRequestService and an isolated
MaintenanceOperationStore. It proves exact input admission, durable original and
command replay, changed-input and unknown-field refusal, authentication/local
privilege, stopping and preparation-error propagation. A controlled preparation
port avoids asset/network/Host effects; active work prevents restart scheduling.
These checks do not prove a real backup, installation or replacement.

The old public installer, cached request/dispatch intent, command receipt and
update original remain immutable. A failed Desktop command and absent addressed
maintenance row do not establish global NO_EFFECT. Actual continuation belongs
to the supported owner after the prerequisite changes, under the same original
business identity; this source change does not replay an old CLI or mint a new
update identity.
