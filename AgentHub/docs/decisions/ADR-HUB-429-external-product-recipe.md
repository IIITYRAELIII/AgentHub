# Product recipes outside the release platform

The user's 2026-11-13 instruction completes the boundary begun in
ADR-HUB-419: the Agent Hub recipe must no longer require Hub's private build,
packaging, publication or installation orchestration functions. The platform is
also usable for other products. This changes the former self-build exception.

Hub owns Tasks, Test/Await integration, reviewed source and prepared/frozen Git
custody, authorizations, SQL CAS, original request receipts, generations and
continuation/finalization. A pinned recipe owns product metadata materialization,
validation inventory, build, archives, recipient bytes, distribution and the
product's installation orchestration. A recipe never opens the platform stores.

The verified export declares `releaseRecipe.apiVersion` and its module. The
generic runner reads the original operation/generation through the existing
canonical store and supplies an explicit immutable input to that module. Only
the versioned frozen-candidate/Git API, existing timing and runner location cross
composition. Application-specific functions and replacement owners do not.
Recipe configuration and target ordering are JSON values included in the normal
authorization fingerprint. The same canonical authorization also binds the verified executor name, version, digest, physical root and directory identity. Capture passes that authority into freeze; the original manifest and freeze intent retain it. Reuse, the publication adapter and runner compare it before product effects. Existing legacy records are not backfilled or retargeted. Recipe values do not grant permission themselves.

Agent Hub's running application still owns its public maintenance protocol:
status, exact Ready evidence, configuration validation, prepared-package install
and canonical maintenance readback. The external recipe calls the explicit
`runtime-maintenance.mjs` JSON entrypoint; it does not import application internals
or reproduce its maintenance SQL owner. Cold start, packaging and recipient
selection belong to the recipe. Application startup marks its own readiness;
it does not automatically run product publication finalization.

The candidate's existing `test-suite.mjs --list-tests` command supplies project
inventory. Recipe checks have separate `recipe:` identities and run from the
pinned tool. All executable checks and helper bytes are covered by that export digest, including the moved extension/recipient Python checks. The selected/full validation stage includes both sets and settles
only after their actual children/output close. This transfers checks rather than
adding a new gate. A new selection binds the changed inventory; an admitted old
selection, tool, candidate, namespace or receipt is never retargeted.

Legacy authorization/journal readers exist only to interpret already admitted
operations and prove their original boundaries. Retained executors keep their
recorded tool and exact frozen caller. No new operation can select an old executor
as an implicit fallback. Remove these codecs only after all corresponding
originals and retained recovery consumers are terminal and their history has an
explicit migration. Missing, live, changed, partial and UNKNOWN evidence continues
to refuse an effect. No manual store or receipt repair is introduced.

Acceptance covers a real external CLI build on a controlled source stand and a
second tiny product through the same generic runner API, together with affected
restore, original-readback, drift, late-output and close regressions. Controlled
ports and synthetic cached native inputs are qualified separately from an actual
installed application. Source delivery, release authorization, publication,
installation and restart remain distinct boundaries controlled by their owners.
