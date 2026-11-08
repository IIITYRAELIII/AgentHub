# Frozen release checks belong to the frozen source

Status: accepted for implementation

The release all-plan included both the exact candidate contour and the rolling
dev contour. Publication dispatch runs both in frozen/main; the latter correctly
refuses that source because no dev integration branch belongs to the frozen clone.

The existing release inventory now advertises only the candidate contour and
Worker as special release checks. The existing dispatcher already supplies
`--release-candidate` for that selected ID. No external tool change is needed.
All core and profile inventory entries and ordinary dev-preview behavior remain
unchanged. Old inventory identities still fail normal frozen-plan verification;
this is not a manual selector exclusion or an authority waiver.

The real Git regression follows all-plan discovery through publication dispatch
and source resolution on main. It preserves every pending file check and Worker,
checks ordinary dev resolution, and retains dirty/foreign/source-kind and stale
plan refusal. It runs no browser, full suite or publication effects. Immutable
failed generations keep their original plan; the release owner captures the
corrected inventory only in a later normal accepted generation.
