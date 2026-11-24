# ADR-HUB-509 — Drive shell canary with fixed App Server argv

Status: accepted implementation proposal, subject to exact review.

## Problem

Agent Hub 2.1.21 verified the MCP read on the affected Windows machine.
The next turn requested a different shell command from the expected nonce
probe. The existing approval fence refused it and the installer rolled back.
Model-generated shell syntax is variable even for a fixed prompt.

## Decision

Run one literal nonce probe through the same App Server's buffered
`command/exec` RPC. Hub supplies an absolute System32 Windows PowerShell
argv, an isolated working directory, read-only sandbox without network
access, and bounded execution and output. Require the original RPC response,
exit zero, the exact stdout nonce and empty stderr. The probe consumes no
model command or approval and leaves no raw output in diagnostics.

Keep the existing bound Thread/turn/item approval and execution proof only
as a compatibility path for explicit method-not-found. Remove it once the
supported App Server floor includes the buffered RPC. Timeout, refusal and
malformed results do not enter the legacy path.

The direct RPC covers actual App Server shell execution. Bundle identity,
required Code Mode helper, native custody and real initialize remain at
their existing owners. The RPC does not claim a Code Mode model tool round
trip. The separate model context, authenticated MCP, cancel and resume
proofs retain their current scopes.

Contract: UPD-001.
