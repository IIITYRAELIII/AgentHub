# Contour operational references and external effect exclusions

> Design-stage record: the text below describes the earlier isolated layer.
> These layers are now integrated in HUB-182; current preparation, executed
> full-shell acceptance and remaining exclusions are documented in
> [Recording contour](recording-contour.md). Historical statements about an
> unconditional boot fence or unintegrated callers do not describe current code.

Status: a bounded preparation stage, **not a bootable production-data contour**.
Depends on `test-contour-operational-paths.mjs` from the literal recording-provider
patch. The persistent recording profile's `CONTOUR_RECORDING_BOOT_NOT_READY`
fence remains closed. These modules do not authorize a Hub boot or production
snapshot capture.

## Connected external boundaries

Infrastructure creates one verified policy from the persistent
`testContourRecording.root` marker. Ordinary configurations have no policy and
retain their existing behavior. The marker requires schema 1,
`literal-recording-provider`, its exact absolute root and `externalEffects: deny`.
The profile parser separately requires an isolated runtime and data directory.

The following operations return an explicit `status: excluded`, never a success
claim for the skipped operation:

- Startup release and task Git reconciliation: the existing infrastructure seam
  records the registered Workspace IDs, target roots and registration source,
  without calling either Git owner. Diagnostic repositories are empty with an
  explicit excluded status. Interactive Git/release commands are **not covered**.
- Usage synchronization: scheduling, manual synchronization, enrollment and code
  creation stop before remote configuration, client construction, provider account
  backfill or network. Provider-derived device-label suggestion is also excluded.
  Editing a local device label remains local. The copied contour must use a fresh
  isolated sync identity, not a production identity.
- The startup CBR exchange-rate refresh: cached local data still loads, while the
  remote refresh is excluded.

`external-effects.jsonl` records effect kind, operation, time and an allowlisted
set of Git target fields. It never records enrollment codes, URLs supplied to
enrollment, provider credentials, arbitrary request options or message text.
An unclassified effect is rejected. No blanket timer disabling was introduced:
deferred wake, queue scheduling and terminal audit/recovery owners are unchanged.
Their real execution on copied production data still requires the remaining boot
guards below; an unchanged owner is not evidence that it has run successfully.

## Catalog preparation on an owned copy

`prepareContourCatalog({databaseFile, preparedRoot, paths})` accepts an existing
SQLite copy inside a directory containing `contour-preparation.json`:

```json
{"schemaVersion":1,"kind":"owned-contour-preparation","root":"<absolute prepared directory>","bootable":false}
```

The caller creates this marker only after making the owned working copy from a
verified raw cohort. Raw captured files remain immutable evidence. Paths and
SQLite sidecars cannot traverse symlinks or escape the prepared root. Do not put
this marker in the production directory.

One SQLite transaction remaps exactly:

- `hub_workspaces.settings_json.workingDirectory`;
- `hub_streams.settings_json.project`;
- `hub_threads.project_root`.

Source-to-target mappings come from `createContourOperationalPaths` and preserve
whole path components. Missing non-empty mappings or unexpected settings types
abort and roll back the whole transaction. This is a one-time transform of a
fresh copy, not an in-place repeatedly applied migration.

Workspace, Stream, provider and Thread IDs remain unchanged. Comments, embedded
path text, messages, annotations, journal `record_json` and command-ledger rows
are untouched. The result reports row counts and `bootable: false`. A caller must
persist that report in its acceptance manifest before any later preparation.

## Reversible selection and queue projection

`createContourReferenceProjection(paths)` provides `selection(original)` and
`queueItem(original)`, each returning an operational `view` and a process-local
restore `token`. `canonicalize(token)` returns the original exact path spelling
and submitted evidence while retaining queue bookkeeping such as attempts.

Queue projection requires the original item ID and `clientUserMessageId`. It
checks the real `taskOccupancyIdentity` before and after path mapping. Bound
Stream/provider/Thread lanes retain their keys and order. Root-keyed legacy lanes
are rejected when mapping would change their identity; there is no guessed rekey.
Text and complete annotations are copied literally. Local attachment and cleanup
paths are mapped by their typed fields. Modified identities, targets, submitted
input or receipt/fingerprint evidence cannot be silently serialized back.

The token is neither a durable receipt nor a second state owner. It cannot be
reconstructed from text or persisted as an alternative command ledger. This
projection is **not yet connected to RuntimeStateStore**: provider launch already
maps a canonical root, and intake fingerprints are computed before that store.
Connecting a wrapper now would risk double mapping or changed retry fingerprints.

## Remaining gates before production-data acceptance

1. Wire operational config/projects, catalog, client selections and queues through
   one coordinated mapping, including canonicalization before fingerprinting and
   the literal provider boundary. Preserve canonical ledger receipts on retries.
2. Route task read-model and journal lookups without rewriting canonical history
   hashes. Catalog-only preparation does not close this gap.
3. Prove restored process/PID ownership, output and cleanup paths, attachments,
   provider homes and local-control/current/lock paths belong to the contour.
   Never attach to or terminate a copied production PID.
4. Exclude or record media jobs, delivery/outbox, interactive Git/release routes and
   remaining external adapters at their owners. Cover additional persisted files
   outside the three-DB cohort; do not silently clear recovery work to get a green
   run. Existing core queues and recovery remain mandatory acceptance scenarios.
5. Use the process-owned deadline capture API for the actual cohort; the 1.35 GB
   production snapshot has not been run. A common SQLite read window still is not
   a business transaction or flush barrier spanning independent persistence owners.
6. Exercise actual candidate replacement only after these guards pass. Readiness
   must request protocol 4 with `compactSnapshot: true` until a bounded health and
   identity endpoint exists; compact board snapshots still have a size limit.

Focused verification: `node --test --test-concurrency=1
tests/runtime/contour-reference-effects.test.mjs`. Synthetic SQLite tests check
atomic rollback, canonical evidence preservation, exact occupancy/FIFO, literal
80,000-character annotation, and external-owner exclusion. No Hub is launched.
