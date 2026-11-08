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

The next real frozen all-plan reached Windows `spawn ENAMETOOLONG` before the
selected-test child could start. Its 797 core IDs formed one 44,741 UTF-16-unit
argument. Publication now retains the whole verified plan, source root and commit
in a digest-addressed payload. The existing runner receives only its file path
and SHA-256, verifies current source/inventory and derives the same complete core
selection before execution. File publication is atomic and never replaces a
retained payload. Direct inline callers keep their existing API.

The independently pinned release tool needs the corresponding small dispatch
companion, declaring the selected plan on the existing checkpoint-runner step.
Hub prepares the payload only when that step actually executes. Its old immutable package
and admitted generations remain retained. A corrected coherent Hub source and
new reviewed tool input are delivered together through their existing owners.
