# ADR-HUB-388 — Prepare the next release before installing its predecessor

Date: 2026-11-01
Status: implementation, independent review pending
Contract: REL-001

The public release may finish before its recipient update succeeds. The existing
installed-source reader incorrectly always chose the installed source as the next
composition base. With installed I strictly before published P, it then required
P to be an ancestor of I. Returning no provenance would also select an older
agreed local main in the ordinary preflight and could lose published changes.

The existing reader now distinguishes the exact retained installed source from
the composition source. Only a manifest-bound clean installed source that is an
ancestor of the already authoritative OWN publication selects P. The existing
closed installed-local-source-v1 envelope keeps the real installed release and
manifest pins; sourceBaseCommit=P, sourceBaseTree=P's exact tree and the empty
binary patch digest record zero installed-code carry. No new caller flag, base
writer, approval receipt, lifecycle route or publication authority is added.

The existing verifier admits this equal-base representation only with a distinct
older installed source. Its canonical runtime manifest verifier checks physical
files; retained source HEAD/clean/ancestry, installed metadata, origin/adoption,
plan and selected identity remain checked. Pointer and manifest are reread after
verification. The existing preparation, terminal and freeze owners repeat this
proof. An empty patch alone is not source authority. It cannot fabricate a newer
installed runtime, merge incoming origin or rewrite a prior envelope.

An equal published installation retains its existing no-carry route, including
retired generation handling. A private repair ahead of publication keeps its full
physical/source carry proof. Diverged or unrelated source refuses and remains
preserved. Unknown publication/update outcomes and old operation receipts are
unchanged. Runtime install/restart/publication remain Release Manager operations.

Behavioral evidence uses the existing real Git fixture and native candidate
owner: a newer published server and module survive alongside the selected Task,
while the installed pointer, bytes and old retained HEAD stay unchanged. Negative
cases cover physical/source/manifest/origin and concurrent pointer/manifest
changes, plus private ahead, divergent and unrelated source histories. This is
source/candidate evidence, not a claim of a completed public update.
