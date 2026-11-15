# ADR-HUB-422 — External package scratch and closed acceptance disposition

## Context

The public installer retained its downloaded package outside the runtime, while
the installed graceful handoff independently allocated scratch from TEMP. The
maintained Windows acceptance profile deliberately locates TEMP inside the
runtime. Consequently the stopped backup correctly refused its internal
destination after old runtime retirement. The exact original remained UNKNOWN
before installation. This observation does not establish a failure on ordinary
Windows systems whose TEMP is external.

## Decision

Use the verified public installer directory as the external parent for a newly
owned unique handoff scratch. Keep the five-key public restart business input.
Bind physical directory identity and prove the prospective backup destination
before stopping, then repeat the unchanged stopped backup guards. Existing
original bindings are immutable. The old default error code EEXIST remains
observable for occupied destinations.

The release owner explicitly selected `failed-retained-stopped-current` for the
already closed QA original. Implement this as addressed reconciliation inside
the existing maintenance and native handoff owners. The request binds the full
original digest/revision, immutable handoff, native identities, exact helper
manifest, closed acceptance marker/fence and retained data custody. The complete
UNKNOWN row is retained before native admission. A live or identity-unknown
owner, changed selection/current/data, foreign scope or CAS refuses.

The native root gate, existing physical installation lease and fresh stopped
handshakes protect the canonical FAILED write. The installation lease retains
current/payload checks through the write, excluding a concurrent stopped installer.
All four recorded process IDs must be closed, including the old Node,
old Host, handoff Host and launcher. A reused live PID refuses. A surviving
original named Job must report zero active processes. Only Windows' explicit
missing-object result permits the absent-Job observation after the other proofs.
The prior owned backup-phase refusal supplies historical retirement provenance.
No process is killed. Neither installer nor launcher runs, and no acceptance
fence is removed or ignored. Lost replies read the same disposition intent.

Protocol-v1 compatibility is bounded to the observed first-attempt revision7
topology, exact pre-backup error and whole manifested owners with these SHA256s.

- `runtime-package-handoff.mjs` has SHA256
  `5355d7ff03a34bfbab90a7c302b45b26112e854bf44f1467f45a1bac18c5186a`.
- `runtime-maintenance-backup.mjs` has SHA256
  `c01a3a7bf0b2a0dff909e617f6f1731635c588e11b3f782fd53b130df2698b10`.

The guarded branch of those exact owners throws before creating the backup or
invoking installation. The canonical native binding and full current proof are
also required. Error wording or process absence alone supplies no authority.
Remove this compatibility branch after these addressed legacy originals receive
their disposition. Subsequent qualified owner failures carry typed evidence.

## Verification and limits

Maintained Windows regressions execute real preparation/directory and SQLite
backup owners, then real compiled native gate/process checks and canonical
maintenance persistence. Public metadata, ready-current capture and inspection
are controlled ports in the preparation fixture. The recovery fixture supplies
a typed canonical cohort receipt with joined real process IDs. It proves the
recovery implementation and guards, not historical QA settlement or a complete
public automatic update. The real QA original remains the release owner's live
effect after independent review. The public 2.1.5 assets and completed release
are unchanged.
