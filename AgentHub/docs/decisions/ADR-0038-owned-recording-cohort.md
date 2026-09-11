# ADR-0038 — Owned recording cohort for recovery checks

Status: accepted for the isolated recording profile; production parity remains
an acceptance result, not an implication of this decision.

## Context

The legacy Test Contour discards runtime state and uses an immediate fake
response. It cannot establish whether durable queues, interrupted terminals and
delivery receipts survive replacement. Copying production databases alone is
also insufficient: retained paths and process identities can reach live files,
repositories and services.

## Decision

Capture the three SQLite owners under bounded read pins and verify unchanged
queue sidecars across that window. Preserve raw bytes and hashes. Prepare a new
owned root and map only declared operational project/path fields. The capture
does not claim an atomic transaction across independent stores.

Run the normal Hub owners with literal recording providers, isolated homes and
durable local delivery receipts. Preserve command and terminal identities.
Verify the prepared profile before startup. Exclude captured processes, rollout
readers, interactive Git and media work at their owning boundaries. Exclusion
is visible evidence, never successful remote work or permission to clear the
original records.

The existing contour lease, exact source/release/PID readiness and single dev
preview remain authoritative. Legacy clone/reset refuses prepared data.

The explicit adoption boundary stages a pristine prepared cohort inside the
existing canonical root while retaining the source. It rebases only typed owned
operational identities. The root and its lease never move. Candidate preparation
and manager compatibility precede stop; a persisted component transaction keeps
old SQLite sidecars, profile and control documents. Interrupted prelaunch
replacement rolls back after stop. Exact ready-after-interruption commits the
adoption receipt without losing candidate writes. Ambiguous postlaunch state is
preserved for reconciliation rather than destructively rolled back.
Recovery requires the exact adoption operation and its root/contour target to
remain current before any stop or rollback. The lease alone cannot authorize
acting on a newer generation created by an older manager unaware of adoption.

## Consequences and acceptance

Synthetic full-shell queue, terminal, delivery and restart checks can run without
real provider prompts or remote effects. Their reports must enumerate exclusions.
A production-sized captured cohort, safe replacement of distinct runtime
artifacts and live provider/media behavior are separate acceptance claims.
No full-parity flag is inferred from startup or a green synthetic scenario.
Git operations remain unavailable until an owned Git cohort is implemented and
checked; retained production references cannot be used as a fallback.

Historical read coordinates are not command authority: reads retain canonical
containing-project paths while admission still checks the exact captured binding.
Mutable recording Thread names have a separate local metadata table and cannot
rewrite seeded provider/Thread/Stream identity or create a command.

Windows artifact acceptance may prepare its own fresh recording cohort from
explicit raw capture inputs. Marker v2 persists exact profile/config identities
across independent RuntimeHost launches; it does not adopt the running rolling
contour. Existing v1 synthetic acceptance remains a distinct profile. Cleanup
depends on stable acceptance ownership rather than mutable profile hashes.
The existing restart barrier still owns pending work: the harness cannot finish
captured commands or claim queue recovery from readiness alone.
