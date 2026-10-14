# ADR-0084: Reviewed selected Task composition across divergent publication

Status: implementation proposed for independent exact review; not a live Test
or publication receipt.

Accepted local main and published main can diverge after separately approved
work. A Task may contain both histories, while rolling dev contains other Test
results. Requiring the published side to extend local main rejects that valid
shape; dropping the ancestry check would admit unpublished history. Merging
rolling dev into the Task would also misattribute unrelated work.

The existing Task Git owner therefore takes a distinct proof, not a looser
explicit-upstream-adoption proof. Its immutable input is a reviewed two-parent
`[oldDev, exactTask]` composition, exact publication generation/revision and
live remote, one unique local/published common base, one published-side Task
first-parent merge, and all conflict stage/result entries. Preview recomputes
these in a disposable clone and binds its caller, Task revision and bundle
bytes to one hash. A later request confirms that hash under the Task,
repository and Await locks and persists the original lifecycle intent before
Git effects.

The ordered proof commit is the only allowed new dev ref, advanced by one
expected-old CAS. A per-operation durable journal stages regular-file content
on the same filesystem. Additions use an exclusive hard link; existing tracked
files are moved to private backups before linking reviewed bytes. A late
ignored/private target is never overwritten, and recovery from a post-CAS
collision uses the same operation and journal. Only clean exact worktree/index,
result ref and receipt permit Test's Task CAS. Unsupported path shapes reject
before ref effect. This is not a general-purpose filesystem materializer.
Intent, journal and completion records become authoritative only after a
complete synced temp file is linked to its final name. A pre-CAS crash may
leave incomplete private staging; the same operation discards only known
unpublished new-file/temp names and rebuilds the journal. An unexpected
backup or completed record is never inferred away. A post-CAS crash before
completion publication replays the exact journal/ref/readback and writes the
same receipt, without another ref update.

The integration proves Test, not release ownership of the whole dev tree.
PreRelease revalidates the durable selected proof and applies the Task delta
from its published merge boundary. Missing proof or a changed publication
fails closed; ordinary fallback to effective dev replay is forbidden for this
Task. The selected Task's release delta excludes unrelated dev bytes.

This decision does not authorize accepting a new upstream tip, changing
primary main, retrying a previously failed Test request, or deploying the
candidate without independent review. ADR-0082's accepted-main bootstrap and
ordinary explicit upstream adoption retain their separate authorities.
