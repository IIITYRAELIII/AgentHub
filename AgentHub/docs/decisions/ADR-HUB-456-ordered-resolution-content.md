# ADR-HUB-456: Re-prove resolved content through later automatic edits

Status: accepted with the independently reviewed implementation.

The selected-content owner previously retained an owned conflict resolution only
while the final file entry equalled that resolution's complete entry. A later
clean selected edit could invalidate that comparison. Replaying an older Task
on the final file then recreated already retained adjacent code, despite the
earlier resolution and new automatic edit preserving both selected changes.

The existing native composition owner now re-proves the latest owned resolution
of that path through each subsequent ordered native step. Unchanged entries
retain their exact identity. A changed regular-text entry must be the exact
automatic result of that step's verified parents and binding. Replaying the
prior composed content from the original composition base must reproduce the
next entry without a conflict on that path, or add only an already retained
byte-identical block under the existing idempotent-addition rule. Each successful
step supplies the next composed content proof. Earlier removals and additions
therefore remain obligations; reachability and a once-accepted prefix do not
grandfather a whole path.

This proof runs only for an exact captured ordinary release composition and only
when the existing final replay lacks content evidence. The normal native graph,
automatic outside entries, owned resolution bindings and full selected-result
checks still run. Mode/type changes and binary changes gain no new credit.
Other ordinary Test, multiple-base and publication authority remain unchanged.
No journal field, saved certificate, alternate resolver, cache or public option
is added. All Git math is invocation-local; current authority retains its usual
fresh lifecycle and publication boundaries.

Validation includes an earlier real conflict followed by a disjoint automatic
same-file amendment, exact saved full selection, and refusals for lost earlier
or new content and changed native bindings. Diagnostic saved-graph execution is
not a live Await or release admission.
