# ADR-HUB-416 — Native resolution without an approval token

Date: 2026-11-05
Status: implementation pending independent review
Contracts: REL-001, MCP-001

## Decision

Remove the independent programmatic native-review permission introduced by
ADR-0108. Ordinary Test/Await, dev synchronization and release composition use
their existing Git and application owners. They do not authenticate an ACCEPT
message, sender/receiver, interstream content hash or approval receipt.
Auto-review remains an agent instruction policy under the existing setting.
No Workspace/global rule is changed and no replacement approval input is added.

The issued checkout is still bound to the original selection and ordered Git
inputs. Every completed step is independently reconstructed from objects on
reopen; candidate parents, automatic tree, index/worktree and stored Git bindings
must agree. Historical reviewedResolution stores are read as metadata and exact
Git bindings, without attempting receipt authentication. Ordinary undelivered
amendments retain the same journal and delivered history remains immutable.

Selected-content checking retains real automatic context and valid conflict
resolution, rather than requiring a signed replay waiver. A replay that only
adds a byte-identical block already retained is idempotent. Unique missing code,
lost mode/deletion, forged automatic prefixes, stale selection, different parents and
dirty/foreign checkout still refuse. This is structural preservation evidence,
not a claim that Git proves arbitrary code semantically equivalent.

An actual conflict file remains covered by its exact owned resolution binding
when compatibility corrections also change clean context outside its markers.
Reopen recomputes that coverage from ordered parents, automatic/result trees and
the complete diff; unrelated extra paths never acquire conflict coverage.
Whole-parent substitution, deletion of clean code and restoration of the other
parent's clean context still refuse composition instead of receiving an
override. This is a structural loss check, not a semantic approval of arbitrary
replacement code. No approval token or additional durable state is introduced.
For unique clean context, removed words must be present in the incoming selected
change's removals from Git's actual stage-1 blob; retained replacement words are
not removals. This carries an API compatibility correction without authorizing
an unrelated clean-code deletion or a novel replacement that loses unique code.
The evidence is recomputed, including virtual-base stage-1 content, on reopen.

## Migration and verification

New public status/release/preparation inputs omit native approval fields.
Historical reconciliation still matches its original arguments and immutable
receipts; neither history nor UNKNOWN effects are rewritten. Existing source
entry points invoke these same owners; no alternative driver or publisher is
introduced. Runtime adoption/publication remains with the release owner.

Focused evidence includes owned conflict and compatibility resolution without
an envelope, completed-prefix reopening and lost journal reply, retained actual
blocked composition, content-loss/mode/deletion negatives and stale/foreign Git
identity. It does not authorize installation, restart or publication.
