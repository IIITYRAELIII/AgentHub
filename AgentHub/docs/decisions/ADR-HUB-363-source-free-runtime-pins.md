# Source-free installed runtime pins

Status: accepted implementation pending independent review, 2026-10-27.

The public packager intentionally removes the author's private sourceRoot from
its copied manifest. The recipient installer verifies that payload and records
its exact manifest SHA-256 and physical directory identity in existing
current.json installation custody. Treating every missing sourceRoot as unknown
prevented the existing after-ready owner from retiring any known old ZIP version.

The retention owner accepts that omission only for current/rollback entries
whose raw manifest and physical root match the existing installation binding.
It neither reconstructs a private source path nor treats a distribution marker,
directory name, age or absence of sourceRoot as independent deletion authority.
Explicit null/empty/relative sourceRoot values still refuse. Prepared, legacy,
changed and otherwise unproven source-free entries still conservatively block.
Existing absolute sourceRoot dependency checks remain unchanged.

This is support for the normal shipped manifest format, not a legacy adoption
fallback. It remains necessary while public packages omit private source paths;
removing it requires a replacement recipient contract with equivalent custody.
No new pointer format, writer, maintenance policy version or receipt is introduced.
Current/rollback/running pins, the installation lease, original pruning child,
bounded native batches, partial reconciliation and unknown-data refusal remain.
No repeated whole-body hash or production cleanup is part of this correction.

Behavioral coverage invokes the real recipient installation and verification
contracts for four successive source-free manifests, then the existing service
and native bounded retirement owner on isolated declared fixture bytes. It
checks partial progress/reopen under the same original operation, current plus
rollback preservation, and changed/unknown/prepared/source dependency refusals.
Synthetic stable launcher bytes are copied, never executed. This is not a full
public ZIP build/download acceptance or a production deletion/install/restart.
