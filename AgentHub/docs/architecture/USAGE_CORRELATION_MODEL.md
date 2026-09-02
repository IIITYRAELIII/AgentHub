# Agent Hub usage correlation model

Decision: [ADR-0013](../decisions/ADR-0013-interval-account-attribution.md).
Enforceable field-level contract: [USG-001](../contracts/USG-001-usage-attribution.md).

This document describes the target architecture for team usage synchronization,
derived from the only question the synchronization exists to answer:

> For a billing account `A` and a rate limit `L`, how much account-side limit is
> consumed per unit of locally priced spend, and how does that price change over
> time?

Everything else — the sync transport, the ledger, the device identities — is a
means of assembling the two series that this question compares. The model below
is written from the correlation inward, not from the current sync outward.

## The estimand and what it demands

The correlation card compares, over shared intervals:

- `local(A, t1, t2)` — credits of turns billed to `A` that completed in the
  interval, summed across every device that used `A`;
- `account(A, L, t1, t2)` — positive change of the account-side `usedPercent`
  for limit `L` in the same interval, observed from any device logged into `A`.

`account` is an account-global quantity: two devices logged into the same
account observe the same limit series and the same `resetsAt`. `local` is a sum
over per-device turns. The comparison is therefore only valid when the turn set
is both:

- **complete** — no turn billed to `A` is missing from the interval, and
- **pure** — no turn billed to another account is included.

Both properties are properties of an *interval partition*, not of an individual
record. This is the central point. A single misattributed heavy turn does not
degrade the interval — it inverts it, because the regression runs on aggregate
sums. Attribution that is "mostly right" produces a correlation coefficient
that is confidently wrong, which is worse than a smaller clean sample.

## Why the current design cannot satisfy it

The present implementation labels each turn with an account at write time and
repairs the labels afterwards. Four consequences follow, and all four are
visible in the code today:

1. **The account is ambient state, not a property of the turn.**
   `WorkLogUsageStore` resolves the account by asking the provider which account
   is logged in *now* (`src/application/work-log-usage-store.mjs:552`,
   `src/composition/client-interface-composition.mjs:261`). Rollout backfills,
   terminal reconciliation and post-restart imports all record turns long after
   they ran, so "now" is the wrong account whenever anyone has re-logged in
   between.

2. **Organizational facts are encoded as code.**
   `src/domain/team-usage-accounts.mjs` holds account boundary timestamps,
   per-participant account sets and a device-label override map. The label map
   keys on a free-text nickname the participant typed, and the participant sets
   key on a local GitHub login — neither has any causal relation to which
   account paid for a turn. These are also the only channels through which one
   participant's installation can assert an account for another's device.

3. **Attribution is guessed again at read time, per device.**
   `applyInferredDeviceTimelineAccounts` picks the *nearest* exact observation
   on the same device, before or after, with no bound on the distance
   (`src/domain/team-usage-accounts.mjs:159`). It runs on the installation that
   renders the panel, over events pulled from other people's devices
   (`src/application/work-log-usage-projection.mjs:745`), so each installation
   invents its own answer about devices it knows nothing about.

4. **Sync erases what it cannot trust and then re-invents it.**
   `normalizeUsageSyncEvent` drops account fields unless attribution is `exact`
   (`src/domain/work-log-usage-sync.mjs:96`), which is correct, but the
   projection then re-derives them by inference. The correlation input mixes
   observed and guessed attribution with no way to separate them.

The synchronization server performs no attribution at all
(`usage_sync_server/agenthub_usage_sync_server.py:451`): it stores what it is
given and blanks account fields that are not `exact`. Every wrong attribution is
produced locally, from a table shipped in the source to every installation.

## Turns already carry account-side evidence

The design above was built as if the account had to be inferred from context.
It does not, at least for Codex. Every `token_count` event written into a Codex
rollout carries the account's own limit state inline:

```json
{"type": "token_count",
 "info": {"last_token_usage": {...}, "model_context_window": 258400},
 "rate_limits": {"limit_id": "codex", "plan_type": "pro",
                 "primary": {"used_percent": 40.0, "window_minutes": 10080,
                             "resets_at": 1784488501}}}
```

In a scan of this workstation's history, 102 of 102 sampled rollouts carried
`rate_limits` on their first `token_count`, spanning both `plus` and `pro`
plans. The field is written by Codex itself, at the moment of the turn, into the
turn's own file — so it exists retroactively for the entire recorded history,
including every turn the current code could only guess about.

`used_percent` on the same event is the dependent variable of the correlation,
already paired with the turn that moved it.

`resets_at` is **not** an account identity, and must not be used as one. In this
workstation's history the weekly window shows 474 distinct `resets_at` values
with second precision and no alignment to round boundaries, because the anchor
is the first request of a window rather than a global schedule. That makes
accidental collision unlikely in ordinary operation — but the provider
occasionally resets limits across all accounts at once, which anchors every
account to the same moment and makes collisions systematic exactly when they do
the most damage. Matching also has to tolerate a few seconds of spread
(`02:29:48`, `02:29:51`, `02:30:10` appear as separate anchors), and tolerant
matching widens every collision.

A fingerprint is therefore a **discriminator, never an identifier**.

Claude transcripts carry no equivalent: their `message.usage` has tokens,
service tier and cache fields but no limit state. Claude attribution therefore
relies on the device's own auth store (`~/.claude.json` `oauthAccount`), which
is exact, local and single-valued.

## Target model

### Layer 1 — facts, synchronized, append-only

Three record types cross the wire. None of them contains a derived value.

**`turn`** — what was spent, and the account-side state observed with it.
Device, provider, runtime home, thread key, turn id, started/completed, usage,
model, service tier, credits, and — where the provider emits it — the inline
`limit_id`, `window_minutes`, `used_percent`, `resets_at`, `plan_type`.
It carries **no account name**.

**`auth_observation`** — who was logged in, and when we saw it.
Device, provider, runtime home, `accountKey`, `observedAt`, evidence source,
auth-file fingerprint. This is what binds a fingerprint to a human-readable
account.

**`limit_observation`** — the polled account-side series, as today, but shared.

The identity key is `deviceId + provider + runtimeHomeId`, because the auth store
— not the machine — is the unit an authentication belongs to. One machine with
two homes is two independent auth timelines.

`runtimeHomeId` is a locally stable pseudonym of the resolved `CODEX_HOME` /
`CLAUDE_CONFIG_DIR`. The raw path never crosses the wire: it leaks the user and
the machine layout, and it is a poor cross-machine key besides.

`runtimeHomeId` is salted with a device-local value, so it is comparable only
within one `deviceId`. Cross-device equality of it is meaningless.

A copied profile can produce two live installations reusing one `deviceId`. That
is detected by `installationInstanceId` — random per installation, published on
every observation — and two distinct values overlapping in time under one
`deviceId` raise `identity-collision`, which suspends attribution for that
device. It is never a licence to merge the two candidate sets.

### Concurrency is not ambiguity

The auth timeline does not answer "who was logged in on this machine". It
answers "who was logged in in this auth store". A store holds one account at a
time and a turn executes in a process bound to exactly one store, so within a
key there is never more than one candidate.

A team Codex account and a personal Claude account used at the same moment are
two providers and two stores — two independent timelines, both unambiguous. Two
accounts of the same provider at once require two homes, and a Codex turn's
rollout file physically lives under one of them, so the home is recoverable per
turn rather than assumed.

### Layer 2 — attribution hierarchy

Attribution is a two-step process, and the order matters more than either step.

**Step one — the candidate set.** The accounts a turn may be attributed to are
exactly the accounts that were authenticated **on its own device**, in its own
`(provider, home)`, at some point. Nothing else is a candidate, ever. Accounts
that arrive through synchronization from other people's devices are not
candidates for this device's turns and are never even compared against them.

For most devices this set is a singleton, and attribution is finished before any
evidence is weighed.

**Step two — selection within the set,** by the strongest available evidence:

1. **Self-evidence.** The turn's inline `resets_at` / `window_minutes` /
   `plan_type` discriminate between the device's own accounts and refine the
   boundary of a switch between them.
2. **Device auth epoch.** Observations for the turn's own
   `(device, provider, home)` folded into half-open intervals with explicit
   gaps; the turn's execution window selects one. This is the primary path for
   Claude and the corroborating path for Codex.
3. **Declared epoch.** An explicit human statement, described below. Never
   promoted to observed.

Constraining the candidate set first is what makes fingerprint collision
harmless. A mass reset that aligns every account in the fleet to one `resets_at`
collides own accounts with foreign ones — and foreign ones are not candidates,
so the collision changes nothing. A collision between two of the device's *own*
accounts yields `ambiguous`, which is correct: at that moment the evidence
genuinely does not separate them.

This is also the structural end of the observed failure. Nikita's turns can only
resolve to accounts Nikita's device authenticated to; `baseus` was never in that
set, so no table, label, neighbour rule or fingerprint coincidence can select
it.

`ambiguous` is reserved for one real situation: a re-login inside a single store
while a turn was running, where the start and end evidence disagree. The result
carries both candidates and is excluded from correlation rather than resolved by
preference.

`unknown` is **not a normal steady-state outcome** and is not treated as one. A
turn that ran under some authentication always had an account; if the model
cannot name it, the model is missing evidence it should have had. Every
`unknown` therefore carries a reason code and is reported as a countable defect,
not aggregated into a silent bucket.

The reasons split into two classes, because they demand different responses:

- **Repairable** — `no-inline-limits`, `no-auth-observation-in-window`,
  `home-not-tracked`, `identity-collision`, `no-account-identity`. These are
  collection bugs, and the reason code names the collector to fix.
- **Terminal** — `unattributable-history`: the rollout is gone, or the turn
  predates any observation on a device that will never publish one. Nothing can
  recover it. The interface counts it and stops asking, rather than presenting a
  permanent defect the user cannot act on.

### Layer 3 — own accounts only

The candidate rule generalizes into the invariant the whole model rests on:

> A device's turns are attributed only to accounts that device authenticated to,
> from evidence that device observed. No other installation and no server may
> introduce an account into another device's attribution.

Cross-device joining happens afterwards and only by account key: each device
attributes its own turns to its own accounts, and the correlation groups the
results. Devices never compare fingerprints with each other, so a shared boundary
between two teammates' accounts has no path to become a shared attribution.

Only observations cross the wire — never conclusions. Attribution stays a pure
function over facts, and the candidate restriction is enforced inside that
function, because a device's candidate set is itself derived from that device's
own `auth_observation` rows. A conclusion cached for speed is a projection
cache; it is never sync truth and never an input to another device's
attribution.

Derivation therefore still runs locally on whichever installation renders the
panel — as it does today. The change is that it consumes facts published by the
owning device instead of guesses manufactured by the viewer, and that the same
facts yield the same result everywhere.

### Layer 4 — correlation from paired observations

Because `used_percent` arrives on the same event as the turn's usage, the
primary estimator is a sequence of paired observations `(credits, Δused)`
between consecutive account-window observations ordered globally across devices,
rather than a bucketed join of two independently sampled series. Gap
reconstruction between polls stops being the backbone and becomes a fallback for
periods no turn covers.

Ordering across devices is exactly what synchronization provides, and the
residual is diagnostic: if `Δused` between two consecutive observations exceeds
what the turns in between can explain, spend is missing — an unenrolled device
or a turn run outside Agent Hub. Today that error is absorbed into `r`; here it
is reported.

A pair is only admissible when the interval between the two observations is
well-formed. Each of the following excludes the pair and records why, instead of
being fitted:

- the two observations differ in series key `(provider, accountKey, limitId,
  window)`, or a reset boundary falls between them — a single `limitId` carries
  several lanes with different durations at once, so the lane is part of the
  identity, not a detail;
- `Δused` is negative, which means a provider-side correction rather than spend;
- a turn attributed to the account was still running at either endpoint, so its
  cost is split across the boundary;
- a turn in the interval has no `startedAt`, so spanning cannot be disproved;
- any turn in the interval is `ambiguous`, `unknown` or on a device with an
  `identity-collision`.

The observation time of an inline sample is the `token_count` event that carried
it, not the turn's completion. The two differ, and using completion time would
silently shift spend across boundaries.

The input builder still emits per interval `included`, `contamination` and
`coverage`, and excludes contaminated intervals with a stated count instead of
blending.

## Declared attribution for history

Because inline limit evidence exists for the whole recorded Codex history, most
of what the hardcoded tables were compensating for is recoverable from the
rollouts themselves — but only under the same invariant, not as an exception to
it. A historical turn is attributed automatically when its own
`(device, provider, home)` has a locally observed candidate set and the inline
evidence selects exactly one member of it. No candidate set, or two own accounts
matching on window, plan and anchor, yields `unknown` or `ambiguous`. A code
table is never the fallback.

Declared attribution therefore shrinks to a remnant: Claude turns predating auth
observations, and Codex periods whose rollouts are gone. For that remnant, the
boundaries and participant sets now in `team-usage-accounts.mjs` become rows in a
`declared_epoch` dataset — device, provider, interval, account, author, reason.

Declared epochs rank below observed ones and never become `attributed`.
Correlation **excludes them by default**; including them is an explicit choice,
and the card then marks the affected intervals as declared-used. Knowledge
stays, its provenance is visible and editable as data, and it can never again
masquerade as an observation.

## Boundaries

Pseudonymization is unchanged: raw thread ids stay on the device and only stable
hashes are synchronized. Turn deduplication by `(provider, threadId, turnId)`
without the device is retained.

Two additions widen the shared dataset and are deliberate rather than
incidental: inline limit fields on turns, and shared `limit_observation` rows.
Both expose account limit state that is already visible on the statistics page,
but they move it from one device's local database into the team dataset.
