# ADR-0075 — Complete Codex instruction snapshots at turn start

## Status

Accepted, 2026-09-28.

## Problem and evidence

The single application-context entry selected in September 2026 preserved the
mode-independent developer role, but Codex 0.155.0-alpha.16.3 truncated a long
entry to its ends. The deployed 29,267-byte instruction assembly lost Global,
Workspace and most Guide/Stream rules. A short MCP capability at the end still
worked, so the compatibility canary did not detect the loss.

A no-inference wire probe of the installed signed Codex, with a loopback
synthetic Responses endpoint and an isolated credential-free CODEX_HOME,
reproduced missing middle sentinels in the actual model request. Unchanged
application fragments also disappeared after compaction: repeating the same
values did not restore them. Mode developer instructions were ignored in
Default. Thread developer instructions survived compaction but an already
loaded thread ignored changed developerInstructions supplied by resume.

## Decision

Use the existing application-context channel with ordered parts, each less than
3000 UTF-8 bytes including its snapshot envelope. Split on Unicode code points,
never bytes or surrogate pairs. Preserve every character of the canonical
Guide/Global/Workspace/Stream/context assembly and its ordering.

Each launch uses its existing run identity as snapshot identity; retries reuse
the same built object. A new launch changes every entry, even when the rules
are unchanged, so the provider reinserts the complete snapshot. Each envelope
states that the complete current snapshot supersedes older Hub snapshots,
including removed sections. Old instructions are not patched in rollout files.
User input, client command identity, model, reasoning, mode and task state are
unchanged. No extra model turn or provider restart is introduced.

The compatibility canary puts its synthetic MCP capability in the middle of a
long rules payload. Local wire evidence checks fresh/continuing turns, Default
and Plan, compaction and resume, and the provider-facing request, not only the
outbound Hub RPC.

## Costs and limits

Refreshing application context adds instruction history until compaction. It
is required for correctness on the observed provider version; it must not be
reported as zero extra context. Provider-internal compaction during an already
active turn can remove these entries before the next turn start. This decision
does not claim to fix that internal provider behavior.

Remove fragmentation/forced refresh only after an installed-provider wire
regression proves an authoritative lossless and compaction-aware alternative
for both modes and dynamic rule updates. Do not move Global to the retained
prefix and silently lose another layer instead.
