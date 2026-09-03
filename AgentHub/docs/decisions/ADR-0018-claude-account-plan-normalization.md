# ADR-0018 — Claude account plan normalization

## Status

Accepted. Refines [USG-001](../contracts/USG-001-usage-attribution.md) for
current Claude OAuth account metadata and its account-panel projection.

## Decision

Claude account identity continues to come from `oauthAccount.accountUuid`, and
its credential type remains `oauth`. Neither value is a provider label.

The canonical Claude `accountPlan` is a subscription tier. The reader prefers a
recognized `seatTier`; when it is absent, it uses the recognized
`organizationType` suffix from `claude_<tier>`. `billingType` describes the
payment channel, such as `apple_subscription`, and is excluded from the
canonical plan.

The account panel derives its provider label from the actual usage providers
collected for the account. Known plan tiers are presented as `Pro`, `Max`,
`Plus`, `Team`, `Enterprise` or `Free`. It never presents `oauth`/`chatgpt` as
providers or exposes an unknown technical billing code as a plan.

## Consequences

Current Claude profiles with an empty `seatTier` and
`organizationType=claude_pro` display `Claude · Pro`. Existing Max profiles
that expose `seatTier=max` display `Claude · Max`; a participant with a real Max
subscription must verify the current provider schema after deployment.

Legacy stored plans may still contain `apple_subscription` or
`<tier>:subscription`. The UI recognizes those values for presentation only;
the fallback is removed after a dedicated migration rewrites historical account
metadata to the canonical tier. The first post-upgrade account observation may
produce a new auth fingerprint because `accountPlan` changes, but its stable
account key does not change and no token or billing secret is introduced.
