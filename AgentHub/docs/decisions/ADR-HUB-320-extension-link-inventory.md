# ADR-HUB-320: Read existing linked VS Code extensions

Date: 2026-10-27
Status: accepted implementation proposal, pending independent review
Contract: REL-001

## Context

Publication preparation reads the installed extension identity before installing
anything. Existing Windows installations can use a junction from the VS Code
extension directory to external storage. The inventory applied the replacement
path restriction to this read and refused a valid installed package before it
could derive the next version. This is the observed generation-17 boundary.

## Decision

Inventory follows an existing directory link for package, fingerprint and
provenance reads, keeping the existing publisher/name/version validation. This
intentionally removes the old blanket read refusal. It grants no write/delete
authority over that resolved directory. The existing installer derives a fresh
version, resolves its destination and checks its canonical parent before staging
or replacing it. That write boundary is unchanged, including refusal when a new
destination is itself redirected. Source revision ordering, exact rollback CAS,
prepared-plan comparison, artifact hashes and retry identity remain unchanged.

Inventory retains the validated registration name independently of its resolved
read target. A current plan uses that registration name even when external
storage has a different basename; current application and prepared duplicates
resolve the existing registration to the actual installed directory. Neither
the registration nor the external storage is rewritten.

## Evidence and limits

A real Windows junction reproduces the original inventory refusal. The same
behavioral case covers identity/plan reads, fresh-version application and prepared
retry while checking every external fixture file remains byte-identical. A
separate redirected-new-target case retains write refusal with no staging or
external mutation. Existing source-ordering and unchanged-install controls carry
their original assertions. Tests use disposable owned directories only; no live
extension installation or publication is implied by these checks.
