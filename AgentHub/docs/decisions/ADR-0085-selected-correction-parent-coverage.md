# ADR-0085: Prove selected correction parent coverage

Status: implementation proposed for independent review; not a release receipt.

The prepared-candidate addition shortcut used the new Task result's single
parent as a forced merge base. Ancestry from the recorded Task base proved the
parent belonged to the Task history, but did not prove its effective bytes were
present in the prior PreRelease tree. A correction that only added an index could
therefore mark the Task projected while omitting its initial rotation, file
addition or deletion. A merge conflict sometimes exposed the defect, but a
disjoint correction could succeed with incomplete content.

The release Git owner now compares the exact tree entries (content, mode and
absence) of every path changed from the Task base to the correction parent.
Rename detection is disabled for this path list so both the removed source and
added destination are checked. Every entry must match the retained candidate.
Only complete equality permits the incremental
three-way correction. If any entry differs or the comparison cannot be proved,
the owner uses the existing full selected Task-owned net projection; its normal
conflict and ownership guards remain authoritative. Matching commit ancestry
alone is never a substitute for this content proof.

This changes neither Task acceptance nor the published-base authority. It does
not import rolling dev, rewrite an accepted result, or authorize publication.
The existing valid incremental case remains available when prior bytes are
actually represented. Tests cover an absent initial addition and deletion, a
rotation followed by an index-only correction, fail-closed conflict handling
for a rename whose destination was already present but source was not removed,
neighboring selected work and
exclusion of an unrelated result.
