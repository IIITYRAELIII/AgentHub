# ADR-0013 — Interval account attribution for usage correlation

## Status

Proposed. Supersedes the per-turn account field and its inference and backfill
repairs for usage synchronization.

- Model and rationale: [USAGE_CORRELATION_MODEL.md](../architecture/USAGE_CORRELATION_MODEL.md)
- Enforceable contract: [USG-001](../contracts/USG-001-usage-attribution.md)

## Decision

A usage turn carries no billing account. Devices carry authenticated account
timelines, and attribution is an interval join between a turn's execution window
and the auth epochs of its own `(device, provider, runtime home)`.

Synchronization transports observations only, never conclusions: turns, auth
observations and account limit observations. Auth epochs and attribution are
pure functions over those facts, so every installation derives the same result.
A cached conclusion is a projection cache and is never an input to another
device's attribution.

The identity key is `deviceId + provider + runtimeHomeId`, where `runtimeHomeId`
is a device-salted pseudonym, comparable only within one `deviceId`. Raw
`CODEX_HOME` / `CLAUDE_CONFIG_DIR` paths do not cross the wire. Candidate lookup
requires all three parts; falling back to `deviceId + provider` reintroduces the
cross-home mixing this decision removes.

A copied profile is detected by `installationInstanceId`: two values overlapping
in time under one `deviceId` raise `identity-collision` and suspend attribution
for that device rather than merging candidate sets.

A turn's candidate accounts are exactly the accounts authenticated on its own
device in its own `(provider, home)`. Accounts arriving through synchronization
from other devices are never candidates. Evidence only selects within that set,
so a fingerprint collision with a foreign account — including a provider-wide
simultaneous limit reset — cannot change an attribution.

Where the provider emits account limit state inline with the turn — Codex writes
`rate_limits` with `resets_at`, `window_minutes` and `plan_type` into every
`token_count` event of a rollout — that self-evidence discriminates between the
device's own accounts and refines switch boundaries. `resets_at` is a
discriminator, not an identifier: it is anchored to first use, not to a global
schedule, and a fleet-wide reset aligns it across unrelated accounts.

Attribution is tri-state. A turn is `attributed`, `ambiguous` with a candidate
account set, or `unknown`. Gaps in the auth timeline are explicit values and are
never crossed by interpolation or nearest-neighbour matching. `ambiguous` covers
one real case: a re-login inside one auth store during a running turn.
`unknown` is not an accepted steady state — it carries a reason code and is
reported as a collection defect. Correlation excludes contaminated intervals and
reports the excluded share instead of blending observed and guessed attribution.

Historical knowledge that predates auth observations survives as a `declared`
epoch dataset with an author and a reason. Declared epochs rank below observed
ones, never become `attributed`, and the correlation card states whether they
were used.

## Consequences

Hardcoded account boundaries, participant rosters and device-label overrides
leave the code. A rollout or terminal turn imported after an account switch is
attributed by when it ran, so no import path can retro-label history, and the
write-time "current account" lookup disappears.

Historical Codex attribution is largely recoverable from the rollouts, so the
declared dataset shrinks to Claude turns predating auth observations and periods
whose rollouts are gone. Periods that remain without evidence are reported as
excluded rather than filled.

Because `used_percent` arrives on the same event as the turn's usage, the
correlation's primary estimator becomes paired `(credits, Δused)` observations
ordered across devices, and poll-gap reconstruction drops to a fallback.

Account limit observations become part of the synchronized dataset. This is
required to make the dependent variable team-wide and to recover poll gaps; it
widens the shared data beyond spend and is delivered as a later stage, never as
an identity channel.

Migration is compatible rather than a single cut. New clients publish the fact
schema; the server and new clients accept legacy usage events as input while
demoting their account fields, so an installation that never updates degrades to
`unattributable-history` without polluting attribution or breaking import. A
one-off refill from rollouts repairs only devices whose rollouts are still
present locally; another participant's history cannot be recovered without that
participant updating.

Implementation is staged so each stage is releasable on its own: schema,
collectors and read compatibility; attribution and exclusion diagnostics;
correlation estimator; interface card with design consultation; removal of the
old tables and backfills last.
