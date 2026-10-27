# ADR-HUB-321: Retain installed source metadata after main advances

An accepted Task can retain the installed source's CHANGELOG while a verified
source base incorporates later agreed-main notes. The existing installed-byte
proof accepts that new base, but discarding the installed source's metadata
identity then mistakes the unchanged Task metadata for newly authored notes.

The installed-source verifier returns both metadata identities to its existing
native-history caller. The additional revision comes only from the hash-pinned
installed manifest's publicationRevision. Its retained source HEAD must equal
that revision, be fully clean and remain an ancestor of the verified source base.
Legacy manifests without this complete source binding retain their existing
single-base behavior. No caller field, registry, receipt or authority flag is added.

The native history verifier itself is unchanged. Exact path/mode/blob metadata
and package-version checks remain mandatory; foreign merge sides are still
rejected. An arbitrary historical ancestor is not a metadata authority. Origin,
manifest, installed bytes, current pointer, source and terminal CAS guards remain
owned and repeated by the existing preparation/candidate/freeze boundaries.

This correction does not rewrite accepted Tasks or replay acceptance, alter an
old manifest, move primary or grant publication authority. An initial draft based
on a unique common merge base was discarded: actual selected history has multiple
merge bases and explicitly restored, independently accepted metadata.
