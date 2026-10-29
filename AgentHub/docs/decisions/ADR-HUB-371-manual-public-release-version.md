# ADR-HUB-371 — Manual public release version

Status: accepted for this change

The user requested direct control of all three public version numbers. Semantic
major/minor/patch presets do not express that request. Reuse the existing
`hub_release_run` authorization, generation preparation and publication freeze.

An optional stable `release_version: "X.Y.Z"` becomes `authorization.releaseVersion`.
It is normalized with the existing semantic grammar, hashed and persisted by the
same owner. Omission does not insert a default into historical identities. The
existing source JSON entry and operator `publish:changed --version X.Y.Z` expose
the input; there is no existing browser release-launch form to extend.

The adapter and preflight forward this intent to generation preparation. Its
existing prepared-input hash includes the value only when supplied. The existing
freeze receives it as `expectedVersion`, creates its ordinary metadata commit,
and retains the original public version and runtime build across recovery.
Existing downgrade, selection, source, RM, lease and publication guards remain.
No direct package edits, second allocator, writer, table or release operation is
introduced. Already admitted generations and historical receipts are immutable.

This feature is a future release result. It does not change the user's separately
authorized current release from its automatic patch version.
