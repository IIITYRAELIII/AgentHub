# ADR-HUB-507 — Run the canary MCP read through App Server RPC

Status: accepted implementation proposal, subject to exact review.

## Problem

A completed model turn can skip the MCP call. Agent Hub 2.1.20 treated that as
an installation failure because the isolated server had no exact read proof.
The diagnostic report omitted the observed read count.

## Decision

Keep the model proof of the application context using a public verification
code. Drive the actual isolated read with App Server's `mcpServer/tool/call`
for the exact Thread and authenticated test server. Require the real server
effect and matching successful RPC response. Keep the independent real shell
proof and the remaining lifecycle checks.

The legacy model-driven call applies only when App Server explicitly returns
method-not-found and the isolated server observed no attempted read effect.
Remove this compatibility path when the supported App Server floor provides
the direct tool-call method. Its existing exact elicitation scope still applies.
Do not retry an ambiguous call. Persist only allowlisted startup states and
counts, without responses, credentials or prompt data.

Contract: UPD-001.
