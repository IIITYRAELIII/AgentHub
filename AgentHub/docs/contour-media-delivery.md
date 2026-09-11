# Recording contour: media and delivery boundary

The tracked recording profile connects the existing background and delivery
owners through explicit effect adapters. Config selects these adapters with
`testContourRecording: {schemaVersion: 1, root}`; the root must have a verified
recording provider marker. Ordinary runtime behavior is unchanged.

`PersistentBackgroundJobController.restore()` loads captured jobs but excludes
them before inspecting forwarded image jobs, scheduling work or changing an
attempt. Payloads and valid job files remain intact. `size` retains the visible
count; `activeSize` excludes inert jobs from restart admission. New media enqueue
fails with `CONTOUR_MEDIA_EXCLUDED`, rather than silently accepting unusable work.
Direct media download, image capture/analysis, voice transcription, Python/TTS
spawn and voice upload are excluded before network, timers or media file access.

`PersistentDeliveryOutbox` keeps its normal durable state machine, uncertainty
handling and terminal ACK callback. The composition selects a recording delivery
transport that receives its existing third argument: `deliveryId`,
`idempotencyKey`, and `attemptId`. The transport publishes a synced immutable
receipt with an atomic exclusive hard link under `recording/delivery-receipts`.
Same identity and body return the existing Telegram-shaped result after restart
or a lost ACK; a changed body fails closed. Receipts retain a body fingerprint,
method and first attempt identity, not message contents. `sendPhotoFile` records
the envelope without reading the referenced photo. Unknown methods are rejected.
This receipt is the simulated external effect; it does not schedule retries or
replace the outbox/terminal commit owners.

Installer configuration preparation validates the marker and saves canonical
project identities in `recording/recording-projects.json`. Runtime configuration
derives operational project paths and literal provider CLI arguments from this
descriptor. A missing or changed descriptor cannot fall back to fake mode.
Recording refresh checks the boot profile before recovery/cutover, and legacy
production cloning refuses a recording cohort before stopping or resetting it.
Replacing captured data requires a fresh coherent prepared cohort.

Both manager and Hub child processes receive only an OS environment allowlist
and freshly prepared owned home, application-data, provider-home and temporary
directories. Inherited PATH, NODE_OPTIONS and provider credentials are not
forwarded. After profile validation, the real configuration loader derives the
Node executable and packaged literal provider scripts itself and disables Codex
auto-update and provider rate polling. Remote Worker/tunnel, shared bot, Android
and Sentry enablement are rejected; Telegram requires the synthetic token and an
explicit loopback HTTP endpoint. This does not disable local Mini App support.

Behavioral tests cover captured-job byte preservation, direct effect rejection,
real outbox composition and metadata, terminal ACK recovery, lost transport ACK
with one receipt, and refusal of legacy runtime reset. Media execution itself is
an explicit parity exclusion. These adapters alone do not authorize a full Hub
boot; the profile fence remains until prepared-cohort and startup checks pass.
