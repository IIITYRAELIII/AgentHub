# Prove inherited automatic absence through common publication ancestry

Status: implementation for independent review and delivery.

## Context

Two independently accepted dependency tips can both descend from the same
sealed publication and replace it in the exact common-base set. A Task leaves
published entries unchanged while later dev removes them. The actual native
automatic merge retains their absence, but agreed-base replay can reinsert them.
The earlier absence proof recognized only publication itself in the base set.

## Decision

Extend only that existing proof: if publication is not itself a common base,
every exact freshly recomputed common base must contain the same sealed
publication. Existing identity/tree validation and agreed-base ancestry still
precede credit. The whole selected source entry must equal the publication by
mode/type/OID, and both actual automatic output and candidate must omit it.

Multiple-base replay and virtual replay policies remain unchanged. No Task
base, history record, path list or once-accepted exemption is introduced. Own
earlier/new changes, changed entries, non-descendant bases, missing authority,
contained automatic maps, graph/resolution drift and clean context keep their
existing checks. The prior exact-publication-base case remains supported.

## Verification

Real Git regressions exercise two descendant bases, inherited deletion, own
loss, a non-descendant base, publication identity and automatic graph drift.
The saved original Test graph is separately verified through the public native
owner with exact eight source/publication entries and actual automatic absence.
Historical UNKNOWN and supported-stop receipts remain historical; diagnostic
proof is separate from normal Test, Contour, acceptance and publication.
