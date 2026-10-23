# ADR-0120: Inherited repository files in retained installed source

The local-source verifier compared the retained installed source to the older
OWN publication and rejected every changed path outside AgentHub. A source
checkout that preserves exact already-agreed repository files can therefore
fail even though it introduces no changes to another component. The installed
91db source retains exactly the current accepted main outside AgentHub; its
two later skill commits are not changes to the AgentHub runtime.

Keep the existing local-source verifier, provenance schema and all origin,
selected adoption, source/patch, manifest/physical runtime and compiled Host
proofs. When its changed paths include a non-AgentHub path, compare the entire
outside path/mode/object set of source and exact agreed main. Use raw NUL Git
records, reject ambiguous/malformed inventories and bound each inventory to
4 MiB and16,384 entries. Exact byte identities avoid quoted Unicode names or
pathspec interpretation. A missing, extra, changed or mode-shifted outside file
refuses; inherited files are not runtime carry or installation inputs.

This is not an approval of a new origin, a replacement for ordinary exact Task
upstream-adoption receipts, or permission to update skills. The same verifier
runs at the existing native Test/candidate/terminal boundaries. All runtime
carry still needs actual installed byte evidence; unsupported Host paths and
missing/tampered compiled artifacts retain their existing refusals. No writer,
public flag, new receipt family, retry or metadata repair is introduced.

Focused real Git regressions in local-source-baseline.test.mjs cover accepted
main inheritance, Unicode/bracket names, outside content/mode/path-set drift,
malformed raw records and inventory limits. Existing source/physical-runtime,
selection, origin, Host artifact and candidate rollback guards remain in force.
