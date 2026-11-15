# ADR-HUB-385: retained source after generation retirement

Status: implementation draft; independent exact source/current and operational
review are required before using it for accumulated captures.

## Failure and owner

The release generation owner archives its exact identity, frozen checkpoint and
raw publication evidence before removing the disposable generation. An interrupted
removal can leave a source/dependency/WIP remainder after live identity/Git have
already gone. The runtime prepared from that generation still declares sourceRoot.
The native retirement owner correctly refuses an unexplained missing Git marker,
but this legitimate partial generation state then blocks unrelated captures too.
This is not proof that the remainder is disposable, or that an earlier native
archive failed pack can be replayed.

## Decision

Retain direct source path pins and the existing actual Git/commondir/recursive
alternate traversal. For the exact deterministic release-gens original path only,
the existing completed-generation reader and archived original metadata can prove
that a Gitless source remainder is not a Git object-store borrower. Live generation
identity must be absent; stable plain archived identity recomputes the original
operation/generation/repository hash and key. The canonical completed candidate,
frozen checkpoint and raw manifest agree on exact paths/publication/manifest hash.
Unfinished, superseded, ambiguous, foreign or changed authority still refuses.

The canonical readGeneration port is passed through the same TaskGit/native
retention factory and existing background composition. No new database, registry,
approval ledger or latest-publication substitution is added. Installation custody
and the same bounded per-generation lease fence these reads. Ambient Git storage
or history inputs refuse before authority and again after the canonical read;
any restored Git marker must take the ordinary borrower path on the fresh check.

The entire source remainder, WIP, prepared body, archived metadata and unknown
maintenance original stay retained. This decision grants only ordinary eligibility
checks for unrelated captures, followed by their unchanged full archive/native
guards. It is not a generation deletion mechanism, manual Git repair, UNKNOWN
settlement or permission to overwrite an old failed archive transfer.

## Evidence and limits

One maintained real Git/SQLite/Windows native case reproduces the parent refusal
after genuine completed-original receipts and archived source metadata. Corrected
owner preserves source/WIP/archive/runtime pointer and the canonical release
snapshot while retiring an unrelated capture through its SAME maintenance child.
Before-Done, raw archive drift, wrong publication and restored alternate borrower
refuse; ambient input before or after canonical proof also refuses. No foreign
data or source is deleted. Private fixtures and all borrowed dependency links are
removed after joining native children.

The general partial generation deletion path still needs its own sealed plan and
original re-entry mechanism. This narrow source pin decision cannot re-enter that
recursive deletion, create replacements, reuse a stale operational grant or claim
the remaining release/dependency/audit storage has been cleaned.

## Native encoding correction

The existing missing-object transfer forced no object reuse, no delta reuse and
a zero delta window. Ten almost-identical 1MiB revisions consequently retained
10,498,888 allocated bytes in a private real Git fixture even though two consumer
views already shared pack file identities. Sharing the inefficient encoding did
not remove its redundant historical blob encodings.

Retain native Git reuse and permit a bounded optional delta search (window 10,
8MiB search memory, one worker). This controls encoding work, not accepted object
content, total process memory or the existing Git deadline. The same fixture with
the corrected command uses 1,057,608 unique allocated bytes, preserves independent
indexes, all original object/type identities and tags, both live consumers across
private leased GC, and later missing-only imports. These are fixture measurements,
not operational storage credits or proof of faster production completion.

The existing original/output detection and strict pack validation are unchanged.
In particular a retained invalid partial pack cannot be overwritten or reissued.
The separately measured checksum mismatch for historical original5837 proves an
invalid retained output; it does not prove no effect or identify the cause of its
truncation. Recovery of that SAME unknown original remains a separate owner
obligation and is not authorized by this encoding change.
