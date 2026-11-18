# ADR-HUB-471 — Autonomous installer storage lifecycle

Contracts: SYS-001, RST-001, PERF-001, REL-001.

## Owner and policy

Extend RuntimeUpdateBackupRetention in the existing StorageRetentionService.
Its owner id, canonical maintenance children, five-backup policy, ready/busy
fence, cadence and bounded native deletion stay unchanged. Autonomous and
package-handoff backups share the same five slots. Protected copies reserve
slots; inability to prove the cap is reported rather than hidden. Confirmed
rollback with previous-ready and no unresolved retirement is a disposed source;
UNKNOWN is not disposition.

The installer checkpoints exclusive backup-directory identity and planned
file names before copying. After child join and authenticated Ready/recovery,
it seals actual produced contents on the SAME update original before terminal
settlement. A caught partial backup may include only those planned paths and
their SQLite companions under the original directory identity. Additional,
linked or changed files refuse. Worker retirement is checked before cleanup.
A live PID with a different birth retires the recorded worker only; denied or
unavailable native lifetime proof retains it. Python's Windows volume identity
uses its low Win32 volume-serial DWORD for comparison with Node/native deletion;
the complete file index still agrees. Original Python evidence is preserved.

Owned extracted package files require the exact package descriptor digest and
whole declared hashes. The release downloader's own ZIP is a separate candidate;
borrowed archive paths are never admitted. Compact request, script, progress,
result and original-history records stay. Runtime data, config, current and
previous code bodies are not candidates. No arbitrary scratch scan occurs.
The existing parent can schedule another normal pass after a terminal creator
exits, rather than retaining its payload for an entire periodic interval.

## Historical inputs and explicit custody

Old successful autonomous originals with a complete canonical backup are
discovered by paged SQL. Their backup reference locates only the exact producer
cache. Preview verifies request/runtime/installer/worker binding and creator
retirement, then reads the descriptor from the same hash-verified original ZIP.
An admitted SAME storage child persists this evidence; original rows are not
rewritten. Subsequent passes use that proof, not another whole-package hash.
Historical backup inventories never acquire extra files. Unbound SQLite
companions or other added content protect that backup even when its separate
exact payload is eligible; new producers seal companions before checkpointing.
Addressed installer-storage-register supports an exact known cache when no
canonical backup reference can locate it. No name/age/size-based adoption follows.
The compatibility route can be removed after historical unsealed originals have
been disposed and all supported producers record autonomousStorage.

Historical partial backups without creator-issued manifests remain unproven.
An explicit delivery-owner custody decision can admit one exact current preview
via installer-storage-register's custody input. This is contemporary custody,
not a reconstructed creation claim. It requires the whole unchanged failed /
rolled-back original, retired recorded worker, exact backup input/destination,
external physical root and every current directory/file identity and hash.
A named later successful update and current-pointer digest protect the working
installation. The decision id and preview digest persist in a NEW storage child;
automatic discovery never exercises this route. Changed original, current,
worker, root, contents, links or added entries refuse. The old UNKNOWN history
and source original remain intact. Remove this addressed route when the admitted
legacy partial roots have been retired; it grants no general orphan scavenging.

## Effect, recovery and observation

The existing canonical child retains complete proof, batch cursor and per-entry
intent before native final-handle deletion. Root is last; a download candidate
keeps its parent cache and compact receipts. Lost replies reconcile absence on
the SAME child. A still-existing unconfirmed intent remains UNKNOWN; it is not
blindly resubmitted. Reopening preserves the same proof and cursor. Real access
or identity failure retains the original rather than reporting reclaimed space.
After completion, the child compacts its inventory to bound proof digest, counts,
logical bytes and root identity. Loss of the final owner reply settles that same
completion receipt without rediscovery/deletion. Exact older complete proof/cursor
records receive the same readback and compaction; no unknown effect is promoted.
Foreground runApproved may use an owner subset already registered by the same
parent; it preserves other owners' cursor and pending originals. A backup-only
first foreground registry upgrades explicitly to the ordinary installed registry.

Production uses the existing CommandTraceService under the cleanup original:
elapsed batch time, logical bytes, partial/reconciliation and fixed artifact
class only. It does not claim physical free-space gain or exclusive I/O time.
Proof hashing and an already admitted native batch remain cooperative work, not
a hard 20-second execution guarantee. No extra cleanup daemon or backup registry
is introduced.

## Delivery boundary

The source and public installer/package history remain immutable. Root integrates
and delivers this Task; no live cleanup is performed by the executor. New incoming
packages contain the lifecycle helper. An older immutable package lacks that
helper and reports cleanup proof unavailable; its later addressed import uses
the maintained library, never a duplicated implementation. Early package
verification retains the existing exclusively-owned extraction failure cleanup;
unadmitted/unbound download leftovers receive no invented terminal history.
