# USG-001 — Usage fact transport and account attribution

Model and rationale: [USAGE_CORRELATION_MODEL.md](../architecture/USAGE_CORRELATION_MODEL.md).
Decision: [ADR-0013](../decisions/ADR-0013-interval-account-attribution.md).
Limit sample conflict semantics: [ADR-0014](../decisions/ADR-0014-lossless-limit-sample-merge.md).
Claude plan normalization: [ADR-0018](../decisions/ADR-0018-claude-account-plan-normalization.md).

## Identity and owner

A usage fact is owned by the device that observed it. The owning device is the
only writer of its own records, and no other installation or server may create,
amend or re-attribute them.

The attribution identity key is `deviceId + provider + runtimeHomeId`. A device
is `deviceId` from the sync identity; `runtimeHomeId` is a device-local
pseudonym of the resolved auth store directory.

## Wire schema

`schemaVersion` is `2`. Version `1` is the legacy usage event and is accepted
for ingest only under *Legacy ingest* below. Unknown record types and unknown
higher versions are rejected, counted and never partially applied.

Server push and pull responses include `usageFactSchemaVersion: 2`. Clients use
this marker to distinguish an upgraded server from a legacy server that accepted
schema 2 JSON but returned/stored it through the old schema 1 path.

Push, snapshot and changes responses from an upgraded server also include:

- `datasetGeneration`: a server-local random generation for the current usage
  dataset. It is stable across process restarts and changes only when the server
  dataset is replaced or rebuilt.
- `serverRevision`: the current monotonic server revision of the dataset.

Full snapshot responses and explicit `summaryOnly` anti-entropy responses also
include `factSummary`: deterministic `{ version, count, byType, digest }` over
the complete normalized fact set, not only the returned delta. Normal push and
incremental changes responses must not compute the full summary on every sync
cycle.

`factSummary.digest` is `sha256:` over canonical JSON lines sorted by UTF-8 byte
order. Each line includes the fact type, canonical identity and normalized fact
payload. Display/cache metadata such as `deviceLabel`, `legacy`, `source` and
`version` is excluded, so two peers with the same transport facts compute the
same digest regardless of local presentation state.

### `turn`

| field | required | note |
| --- | --- | --- |
| `schemaVersion` | yes | `2` |
| `eventId` | yes | dedupe key, see below |
| `deviceId` | yes | owning device |
| `provider` | yes | lowercase, `codex` / `claude` |
| `runtimeHomeId` | yes | pseudonym, never a path |
| `threadKey`, `taskKey` | yes | existing thread pseudonyms, unchanged |
| `startedAt`, `completedAt` | yes | ISO 8601 |
| `usage`, `usageReported`, `model`, `serviceTier` | yes | unchanged semantics |
| `estimatedCredits`, `estimateKind`, `imageGenerationCount` | no | unchanged semantics |
| `limitSamples[]` | no | inline provider evidence, below |
| `deviceLabel` | no | display only, never attribution input |
| `observedAt` | yes | ingest ordering |

Retired context-measurement flags are not part of normalized usage facts. Existing
rows, turn identities and measured usage remain intact; no historical deletion or
database rewrite is required. An unused legacy SQLite column may remain on disk
without being read, written or recreated by the current schema.

A `turn` carries **no** `accountKey`, `accountLabel`, `accountType`,
`accountPlan` or `accountAttribution`. Producing those fields on a `turn` is a
contract violation.

`startedAt` is required in schema 2 because the correlation rules must be able to
prove that a turn did not span an interval endpoint. A record without it — a
legacy turn, or a provider that cannot supply it — makes every interval it
touches inadmissible with reason `missing-started-at`.

`limitSamples[]` entries: `observedAt` (the `token_count` event time, not the
turn completion), `limitId`, `window`, `windowMinutes`, `usedPercent`,
`resetsAt`, `planType`.

`window` is the lane within a limit — `primary`, `secondary`, or the provider's
own name — and is **required**. A `limitId` carries several lanes with different
durations at once, and the existing series identity is already `limitId:window`
(`rate-limit-history.mjs:339`). Omitting it would merge a 5-hour and a weekly
lane into one series and destroy `Δused`.

The series key throughout this contract is therefore `(provider, accountKey,
limitId, window)`. Admissibility of a pair is evaluated per series key, never
per `limitId`.

### `auth_observation`

`schemaVersion`, `observationId`, `deviceId`, `installationInstanceId`,
`provider`, `runtimeHomeId`, `accountKey`, `accountLabel`, `accountType`,
`accountPlan`, `observedAt`, `evidenceSource`, `authFingerprint`.

`evidenceSource` is one of `auth-file`, `account-read`, `rate-limit-read`.

`authFingerprint` = `HMAC-SHA256(homeSalt, canonical([accountKey, accountPlan]))`.
Its only purpose is detecting that the auth store changed between two
observations **on the same device**, which the local salt satisfies exactly.

Token material — raw, hashed or truncated — must never contribute to
`authFingerprint` or to any other synchronized field. A hash of a secret is
still a verifier for guessing it, so hashing is not a sanitizer here.

### `limit_observation`

`schemaVersion`, `observationId`, `deviceId`, `provider`, `accountKey`,
`limitId`, `window`, `windowMinutes`, `usedPercent`, `resetsAt`, `observedAt`,
`reachedType`.

## Dedupe keys

- `turn.eventId` = `usage:sha256([provider, threadId, turnId])`, unchanged from
  the current implementation. The device is deliberately excluded so the same
  turn recovered from a restored journal on another installation collapses into
  one record.
- `auth_observation.observationId` =
  `auth:sha256([deviceId, installationInstanceId, provider, runtimeHomeId,
  accountKey, observedAt])`.
- `limit_observation.observationId` =
  `limit:sha256([deviceId, provider, accountKey, limitId, window, observedAt])`.

Re-observing an unchanged fact is idempotent. Merge of two records with one id
keeps the earlier `observedAt` and never widens attribution.
`installationInstanceId` is part of `auth_observation` identity so a copied
profile cannot collapse the collision evidence before projection sees it.
`auth_observation` and `limit_observation` ids are canonical derived identities:
when canonical fields are present, an incoming id is not trusted and boundaries
recompute it before storage or export.

`limitSamples[]` merges as a set keyed by the normalized full sample body:
`(observedAt, limitId, window, windowMinutes, usedPercent, resetsAt, planType)`.
Exact duplicates collapse. Conflicting samples with the same `(observedAt,
limitId, window)` but different values are distinct evidence and must both be
preserved. Samples are stored in canonical UTF-8 byte order by the same field
sequence, never by locale collation. The merge is therefore order-independent
and idempotent: two installations holding the same fact set compute the same
correlation input regardless of arrival order.

A later import from a richer rollout may add samples and move an interval from
inadmissible to admissible. That is convergence on evidence, not instability —
the result stays a pure function of the fact set. What must never happen is a
merge that *drops* samples or rewrites their values, because that would make the
result depend on import history.

## Convergence cursors

The incremental pull cursor is valid only together with the generation tuple
`server datasetGeneration + local store generation`. If either generation is
missing or differs from the saved tuple, or the server revision regresses, the
client must treat the cursor as invalid and run a full reconciliation after the
next successful push.

Full reconciliation imports the server's complete fact snapshot as the remote
cache, prunes stale non-local cached facts, and preserves facts owned by the
local device so unsent local observations are never lost. After reconciliation
the client compares its local `factSummary` with the server `factSummary`.

The pull cursor may be replaced by the reconciled `serverRevision` only after
that summary comparison converges. If full reconciliation fails or the summaries
still differ, the client may persist the failure result for diagnostics but must
not advance the cursor, generation tuple or summary proof.

Anti-entropy is bounded by a persisted timestamp. At most once per configured
interval, a client compares the server's complete `factSummary` from the pull
response with its local summary. A mismatch triggers the same full
reconciliation path and projection hook as an invalid cursor.

## `runtimeHomeId`

`runtimeHomeId` = `HMAC-SHA256(homeSalt, normalizedAbsolutePath)`, where
`homeSalt` is a random value generated once per device, stored beside the sync
identity and **never synchronized**. HMAC rather than a concatenated hash, so no
implementation has to invent a delimiter or an encoding.

The salt is required: `deviceId` is public within the team and auth store paths
are guessable, so an unsalted hash would be reversible by enumeration.

`runtimeHomeId` is comparable **only within one `deviceId`**, because the salt is
device-local. Equality of `runtimeHomeId` across two devices is meaningless and
must never be tested.

## Identity collision

`installationInstanceId` is a random value generated at each installation's
first start and published on every `auth_observation`. It is the detector, and
without it `identity-collision` would be a declaration with no mechanism.

Two distinct `installationInstanceId` values publishing under one `deviceId`
with overlapping observation times means a copied profile: the `deviceId` is
being reused by two live installations. That raises `identity-collision`,
suspends attribution for that `deviceId` until an operator resolves it, and is
never resolved by merging the two candidate sets.

A collision is a property of one owning identity. There is no cross-device
`runtimeHomeId` collision to detect, per the comparability rule above.

## Account keys

An `accountKey` is produced only from a stable identifier of a **specific**
account held in an auth store the device owns:

- Codex ChatGPT — `chatgpt:sha256(lowercased email)`.
- Claude — `anthropic:<oauthAccount.accountUuid>`, label from
  `oauthAccount.emailAddress` lowercased, account type `oauth`, and normalized
  subscription plan from a recognized `seatTier` or from a recognized
  `organizationType` (`claude_<tier>`) otherwise. `billingType` is a payment
  channel and never becomes `accountPlan`.

An account's displayed provider comes from the providers of its usage facts,
not from `accountType`. In particular, Claude OAuth accounts display `Claude`,
while `oauth` remains credential metadata only.

For records written before this normalization, presentation recognizes the
legacy `apple_subscription` and `<tier>:subscription` values without rewriting
identity evidence. These aliases are removed after persisted account metadata
has a dedicated canonical-plan migration; until then this is a known migration
gap. A newly normalized observation may change `authFingerprint` once while
retaining the same `accountKey`.

Missing email, missing `accountUuid`, or any other absence of the identifying
field yields **no observation at all**. A partial or synthesized key is never
emitted, and a device with an unreadable auth store publishes nothing rather
than a placeholder.

`api-key` and `amazon-bedrock`, as used by the current
`codexAccountDimension`, are **not** account keys — they name a credential
class, and two unrelated API keys or Bedrock profiles collapse into one billing
identity under them. They must not appear as an `accountKey`.

Such an auth store publishes an observation only if it exposes a stable
non-secret identifier of the individual credential, in which case the key is
scoped: `api-key:<fingerprint>`, `amazon-bedrock:<fingerprint>`. The fingerprint
is derived from that identifier, never from the key material itself. Absent such
an identifier, no observation is published and affected turns are `unknown` with
reason `no-account-identity`.

This is not a coverage regression for the correlation: API-key and Bedrock
billing is not limit-window based, so those turns were never valid input to the
estimand.

## Attribution invariants

- A turn's candidate accounts are exactly those with an `auth_observation` on
  the same `deviceId + provider + runtimeHomeId`. Accounts known only from other
  devices are never candidates and are never compared against the turn.
- Evidence selects within the candidate set and never extends it. Inline
  `resetsAt` / `windowMinutes` / `planType` is a discriminator, never an
  identifier.
- Auth epochs are half-open intervals with explicit gaps. No interpolation and
  no nearest-neighbour matching across a gap.
- Attribution is `attributed`, `ambiguous` with the candidate set, or `unknown`
  with a reason. Repairable reasons: `no-inline-limits`,
  `no-auth-observation-in-window`, `home-not-tracked`, `identity-collision`,
  `no-account-identity`. Terminal reason: `unattributable-history`.
- A `deviceId` under `identity-collision` has attribution suspended entirely.
  Candidate sets are never merged to resolve it.
- Candidate lookup requires all three of `deviceId`, `provider` and
  `runtimeHomeId`. Falling back to `deviceId + provider` alone is a contract
  violation: it is exactly the cross-home mixing this contract exists to
  prevent.
- Only observations cross the wire. Attribution is a pure function over them; a
  cached conclusion is a projection cache and is never another device's input.
- Device labels, participant rosters, GitHub logins and account tables have no
  role in attribution. Presence of any of them in the attribution path is a
  contract violation.

## Correlation input

- A `(credits, Δused)` pair is admissible only when both endpoints share one
  series key `(provider, accountKey, limitId, window)`, no reset boundary falls
  between them, `Δused` is non-negative, every turn in the interval has a
  `startedAt`, no attributed turn spans an endpoint, and no turn in the interval
  is `ambiguous`, `unknown` or on a collided `deviceId`.
- Inadmissible intervals are excluded and counted with their reason. They are
  never blended into the coefficient.
- `declared` epochs are excluded by default. Including them is an explicit
  choice and marks the affected intervals.

## Local cost projection

Raw usage facts retain their exact model and token counters. Journal,
Statistics, turn summaries and currency views derive their local cost from the
single `turnCreditBreakdown` owner and its immutable model-price history. A
version is selected by canonical model id and the turn's exact `completedAt`.
The boundary `2026-09-08T00:00:00Z` is the first verified date because the
official source does not publish a more precise effective timestamp. Turns
strictly before it retain the previous default-tier USD rates per million input
/ cached-input / output tokens: Sol `5 / 0.50 / 30`, Terra `2.50 / 0.25 / 15`,
and Luna `1 / 0.10 / 6`. At and after the boundary the rates are Astra
`10 / 1 / 50`, Sol `4 / 0.40 / 20`, Terra `2 / 0.20 / 12`, and Luna
`0.20 / 0.02 / 1.20`. Astra has one verified tariff and no invented historical
version. A missing or malformed completion timestamp selects the oldest retained
version for that model so opening legacy history cannot apply a newer price.

One USD equals `25 cr`; PTE and currency views convert the resulting canonical
credit breakdown rather than pricing tokens again. Reprojection, rollout
backfill, restart and sync import must preserve the durable completion timestamp
and therefore reproduce the same total. The projection must not introduce a
second surface-specific multiplier or rewrite synchronized usage facts.

The unscoped accounting chart includes every local turn regardless of account.
A synchronized turn is included only when its attributed account has an exact
local Codex account-activity interval containing the configured turn timestamp.
Missing local activity evidence excludes that synchronized turn. The account
selector used by API-limit and comparison views must not narrow this chart.

## Legacy ingest

- A schema `1` usage event is accepted so that an installation that never
  updates does not break import.
- Its `accountKey`, `accountLabel`, `accountType`, `accountPlan` and
  `accountAttribution` are **dropped on ingest**, including `exact` ones: they
  were resolved from ambient state at write time and carry no evidence of when
  the turn actually ran. They are not retained as hints, because a retained
  guess is eventually promoted.
- A schema 1 turn has no `runtimeHomeId`, and the candidate rule needs one. It
  is never joined by `deviceId + provider` alone.
- The only way a legacy turn acquires a `runtimeHomeId` is a **local** refill on
  its owning device: the turn's rollout file lies under exactly one auth store
  directory, so the home is read from the file's own path and the pseudonym is
  computed with that device's salt. No remote party can perform this step,
  because the salt and the paths never leave the device.
- A legacy turn whose owning device has not refilled is `unknown` with reason
  `home-not-tracked` while that device is still active, and
  `unattributable-history` once its rollouts are gone or the device will never
  publish again. It is never attributed on the strength of `deviceId` alone.
- A refill therefore repairs only devices whose rollout files are still present
  locally. Another participant's history is not recoverable without that
  participant updating.
- After a client upgrade to this contract, the client performs one full-history
  usage export regardless of its previous push cursor. The client records that
  resend as completed only after a push response advertises
  `usageFactSchemaVersion >= 2` and rejects no events. Until then the previous
  cursor is not advanced for that migration attempt, so updating the sync server
  later causes the next sync to resend history again instead of leaving it
  stranded behind an old cursor.
