# ADR-HUB-381: Transport installed history before ordinary baseline checks

Status: accepted implementation scope; exact independent review and delivery required.

A retained installed checkout and the registered repository can have independent
Git object stores. Reading retained HEAD and then diffing that OID in another
store fails before the ordinary source proof. The baseline owner therefore uses
the existing exact selected-bundle transport to import that HEAD's reachable
graph before object-dependent checks. No source refs, consumer refs, FETCH_HEAD,
configuration, primary checkout or Task history are rewritten. The complete source
and installed proof still decides whether those objects supply authority.

Current repairs also contain non-runtime installation documentation and root
metadata already owned by publication or a selected Task. The source classifier
recognizes the maintained distribution/INSTALL.md instructions. Full outside-tree
comparison retains agreed main as its default; only exact published root CHANGELOG
and existing regular root README/AGENTS entries from exact selected main-based
results can differ. Task Test may read those documentation entries from its
already lease-protected dev HEAD, matching its existing preview history context.
That context is internal and invocation-local: release callers do not receive it,
and no new field is added to public arguments or sealed baseline provenance.

Missing, modified, unselected or executable outside content still refuses. Root
documentation does not grant a merge side, release-owned notes, version change,
adoption receipt or selection. Existing selected result/plan, current origin,
source/manifest/physical bytes and terminal CAS checks remain independent.

Verification uses separate real Git stores with a parent bad-object reproduction,
the ordinary ReleaseGit derive/validate owner and TaskGit Test process lane.
Metadata controls distinguish selected documentation, protected Test preview,
published notes, unselected bytes, deletions and mode changes. Current installed
source compatibility is checked separately without treating a private fixture as
an actual Task acceptance, runtime delivery or release.
