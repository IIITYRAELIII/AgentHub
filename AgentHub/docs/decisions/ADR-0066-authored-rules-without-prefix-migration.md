# ADR-0066 — Authored rules without prefix migration

Status: accepted

The user explicitly requested deletion of the compatibility mechanism that
recognized standard policy text copied into Workspace or Stream custom rules.

Remove historical policy constants, prefix stripping/replacement and the
editable-rules filter. Remove catalog startup conversion that inferred the
release checkbox from saved text or rewrote saved rules. Existing rule revisions
and settings remain unchanged; absent release settings are disabled as before.

Current release workflow, Release Manager, Team Lead and auto-review templates
remain byte-for-byte unchanged and are selected only by their checkbox settings.
Composition appends stored custom text verbatim. A copied standard block is
ordinary authored text, even when it duplicates a currently enabled template.
Repeated reads start from stored text rather than prior composed output.

Saving still enforces the existing UTF-8 size bound, now against the whole
submitted text with no policy-prefix exemption. This change performs no database
migration, live-field cleanup, role-setting migration change, or publication.

This supersedes policy-prefix compatibility in ADR-0060, ADR-0063, ADR-0064 and
ADR-0065. Their other release, role and lifecycle decisions remain in force.
Validation covers exact custom-text preservation in composition, independent
checkboxes, persistence/reopen without inferred settings or changed rule
revisions, and the unchanged size bound.
