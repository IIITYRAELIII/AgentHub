# Published release service evidence after retention

Status: proposed behavior correction, pending independent source review.

The published-release service closure read only the latest publication pointer
and a permanent release clone's evidence directory. Normal operation generations
use isolated roots, then archive their evidence and retire those roots. A service
card could therefore lose its evidence locator, and a later publication could
replace the selected set used by its preview.

Use the existing release-operation Task index to locate a unique completed
original with exactly the checklist's selected results in the same Workspace
and repository. Reuse the release owner's completed-generation proof, and check
the original authorization, sealed generation, publication target receipt and
finalization inputs. No new ledger, writer, publication or reconciliation path
is introduced.

Read the exact hash-named raw manifest from the normal generation/archive
locations, anchored by the original operation/generation/repository identity.
Keep the previous current-publication reader for legacy records without that
durable original; never use a newer release as historical proof. Missing raw
bytes, ambiguous originals or changed identities refuse. In particular a reduced
generation manifest projection is not enough to recover missing historical raw
bytes.

All existing selected Done results, Workspace/plan, published main ancestry,
clean managed custody, checklist completion, lease, preview/token and terminal
CAS guards remain. Close only the service card; preserve its worktree, source,
original publication receipts and any unfinished operational requirement.
