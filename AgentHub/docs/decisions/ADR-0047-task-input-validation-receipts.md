# ADR-0047: Report Task input rejection as a known failure

Status: Accepted for HUB-235 implementation; deployment follows the Task release.

## Problem

The MCP Task bridge accepted text beyond the domain limit and classified the
subsequent input rejection as an unknown operation. The caller could not tell
that the Task had never been created.

## Decision

Create/update title and description validation runs synchronously before calling
the Task owner, using the existing domain normalization and limits. Only that
closed boundary produces proof of no effects and a terminal failed receipt.
The same request identity returns the same failure. Corrected input is a new
submission. Exceptions from the Task owner, including validation-looking error
messages, remain unknown when effects cannot be disproved.

## Evidence and limits

Behavioral tests cover oversized title, description and combined create text;
the exact combined limit succeeds. Real TaskBoard/SQLite checks prove zero
owner calls and zero records for rejected input. A failure after creating a
record stays unknown. Existing unknown receipts are not rewritten.
