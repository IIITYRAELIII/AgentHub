# Amend release notes on the existing release operation

Date: 2026-10-26
Status: proposed; affected review required

The original authorization pins the exact release notes. HUB-351 may explicitly
expand Task membership after a failed generation, but previously could not provide
the corresponding consolidated entry without changing those original bytes.

Extend the same request-addressed continuation amendment with the existing
release-metadata artifact envelope. Preserve its idle/CAS/not-applied boundary,
request capture and append-only identity. Resolve effective metadata by the last
explicit payload across amendments, then initial authorization. Composition
re-verifies full bytes before preparation; existing freeze and manifests bind them.
No schema/table, second notes writer, publisher, automatic summary or historical
authorization rewrite is introduced. The default and retained old amendments keep
their existing identities. Old request replay never adopts a later payload.

Focused coverage uses the actual durable store/reopen/restore, failed-generation
preservation, omitted and changed replay arguments, legacy refusal, CAS/unknown
readback and the composition adapter with real temporary payload files and drift.

Dispatch first recognizes an existing amendment request ID, even if every optional
field is omitted on replay, before ordinary continue or reviewed-main recovery.
Original argument checks therefore precede observation, store transitions and
scheduling. An unaddressed ordinary continue keeps its existing behavior. The
maintained regression exercises this through the command bridge and actual Store.
