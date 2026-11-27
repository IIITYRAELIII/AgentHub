# ADR-HUB-571. Retain successive native absorptions in Test

Status: accepted.

A survivor can receive more than one source through ordinary Git merges. The
native history guard authorizes merge sides using evidence from Task Test.
Retaining only the newest handoff makes it reject an earlier absorbed side
even though Git has retained both commits.

Each ordinary Test accepts one fresh authenticated handoff. Its native
descriptor links to the previous committed native absorption on the same
survivor and repository. A correction without a new handoff carries the same
latest binding and points to its original Test. An unchanged result reuses its
existing descriptor. The prior result and binding come from the existing
durable lifecycle outcome.

The history guard verifies each exact Git merge and requires its predecessors
to be represented in the ordered survivor history. Source closure selects the
binding for that source from the verified survivor result and rechecks its
current revision and saved Git state. Retained records for a single absorption
continue to verify under the same format. The MCP payload and Git refs retain
their existing ownership.

Contracts: REL-001, MCP-001.
