# ADR-0062 — Prepare publication artifacts before Git publication

## Status

Accepted for HUB-235 point 14.

## Context

The frozen Workspace publisher pushed Git before `runtime:deploy`, which also
built the Windows host and changed the installed runtime pointer. A build error
could follow a successful push. Stage checkpoints recorded successful input
fingerprints without checking that their output still existed. A lost deployment
reply could repeat a completed external effect.

## Decision

The canonical `publish:changed` CLI uses the existing executor, publication lock,
checkpoint and run journal. Its order is candidate validation, the selected test
profile once, preparation of selected artifacts, exact Git publication, applying
the prepared artifacts, component verification, runtime readiness and Workspace
completion. Android preparation precedes Worker/runtime packaging. Preparation
does not change the current runtime pointer, stable launchers or extension.

Runtime manager exposes prepare/install operations; `deployRuntime` composes
them for existing installers, contours and standalone `publish:all`. The prepared
manifest records its frozen publication revision. Installation verifies and
consumes the exact prepared bytes without rebuilding from the source checkout.
The existing stable-file/pointer rollback remains its owner.

Worker assets and the pinned Wrangler dry-run bundle are prepared before push.
Deployment uses that bundle with `--no-bundle`, its prepared assets/config and a
version tag derived from the artifact digest. Readback requires one 100-percent
production version with that tag and an unchanged deployment across the two
observations. Existing HTTP content/convergence verification remains. A confirmed
empty deployment list permits initial publication; unreadable evidence does not.
There is no automatic repeated upload on CLI failure.

The extension payload includes the frozen installer and selected production/test
profiles. Application invokes that installer on the prepared source. Readback
compares package metadata, profile and every installed payload file in the exact
target directory; other installed versions are outside that proof.

Per-component artifact manifests bind the candidate/root and complete payload
hashes. They are atomically published after preparation, and their digests are
pinned in the existing journal before effects. They describe build products,
not a second publication progress owner or readiness database. Preparation checks
each existing product and does not rebuild a confirmed product because another
preparation failed. Incomplete staging without a published manifest is not proof
of a successful build.

The journal records intent before component application. Each repeated attempt
first reads the actual installed result. Exact evidence reconciles a lost reply
without reapplying. A changed/missing result after an admitted effect remains
unconfirmed and stops blind replay, including an unconfirmed Worker upload.
This does not assert that the operation failed. The same run can continue once
readback confirms its intended result. Repair of a different or damaged installed
result needs a separate explicit recovery decision; no destructive repair path
is introduced here.

A runtime installer that returns a definitive error may record `not_applied`
only after the existing pointer and stable files exactly match the persisted
pre-call digest. This permits retry of a rejected/fully rolled-back local install.
Crashes and external CLI failures cannot use that terminal no-effect proof.

Completed CLI retries verify retained artifact evidence and installed components.
Expected runtime identity is saved from the prepared artifact before installation,
never adopted from an arbitrary current pointer. Existing automatic post-restart
completion remains limited to saved publication/readiness/finalization; it does
not prepare, build or deploy anything.

## Migration boundary

Artifact protocol 1 applies to new canonical CLI runs. An old run that reached
Git/deployment without artifact evidence must finish with its original executor;
it cannot silently enter the new preparation path. Exact old completion-only
runs retain their saved readiness/finalization path. No receipt or frozen
candidate is rewritten. Remove the compatibility branch when no supported
pending pre-protocol publication remains. Standalone `publish:all` and
`runtime:deploy` keep their existing combined semantics; they are not alternative
Workspace executors.

## Evidence and limits

Behavioral tests cover ordering, failed builds, process recreation, lost replies,
changed installed outputs, artifact replacement and missing evidence. Filesystem
tests cover real runtime preparation/installation and the Python installer in
disposable roots. A pinned Wrangler dry run verifies real local bundling without
credentials or deployment. Remote publication, production restart, Android
toolchain execution and the full release suite remain part of an authorized
release, not this focused implementation check.
