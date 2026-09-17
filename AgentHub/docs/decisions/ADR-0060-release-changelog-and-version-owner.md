# ADR-0060 — Consolidated changelog and publication-owned version

Status: accepted (HUB-235, 2026-09-16).

The generated Release Manager policy still assigned CalVer selection to the agent,
although the Hub publication pipeline already freezes the version automatically.
Generic Workspace rules must not impose Hub's calendar scheme on other products.

The Release Manager writes one consolidated entry in prepared PreRelease with clickable
Task links and short descriptions. For larger Tasks it summarizes the main
checklist changes, or the result when no checklist exists. Task agents neither
write release-history entries nor manually bump the release version.

The Workspace-prescribed publication mechanism owns version assignment and freezes
the version and entry with the candidate before final checks. Retries preserve
that identity across dates. Hub retains its existing local-date CalVer mechanism;
no generic version adapter or runtime freeze change is introduced here.

The exact former generated Workspace V10 and Release Manager V6 blocks remain migration
prefixes until supported stores can no longer contain them. Composition replaces
them once, preserves custom text and removes generated rules when disabled.
This does not rewrite live Workspace/Stream custom fields.

Validation covers rule composition and migration, and real-Git freeze/retry after
the calendar date changes, including interrupted metadata freeze recovery.
