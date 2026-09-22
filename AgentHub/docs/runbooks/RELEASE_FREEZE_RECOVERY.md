# Release freeze recovery

Use this command only for a reviewed pre-publication freeze attempt whose
durable checkpoint is still `freezing`, or for an exact `frozen` candidate whose
terminal publication run failed at contour validation or full tests before any
publication effect.
It is a bootstrap tool: run it from an
independently reviewed clean checkout and bind that checkout by commit and by
the SHA-256 of `src/infrastructure/filesystem/release-git-workspace.mjs`.

Preview is mandatory and has no file or Git effect:

```text
npm run release:recover-freeze -- --repository <registered-primary> --workspace <workspace-uuid> --request-id <stable-operation-id> --expected-source-commit <reviewed-commit> --expected-owner-sha256 <owner-file-sha256> --expected-plan-revision <plan-sha256> --expected-manifest-hash <manifest-sha256> --expected-prepared-head <commit> --expected-frozen-head <commit> --expected-frozen-tree <tree> --expected-published-revision <commit> --expected-origin-main <commit>
```

The `freezing` mode above is `abandon-freezing-candidate-v1`. For a failed
`frozen` run, add the following exact observed identities to both preview and
confirmation:

```text
--recovery-mode abandon-failed-frozen-candidate-v1 --expected-publication-run-id <run-id> --expected-publication-run-sha256 <status-file-sha256> --expected-publication-checkpoint-sha256 <checkpoint-file-sha256> --expected-publication-log-sha256 <run-log-sha256>
```

When no checkpoint file exists, replace
`--expected-publication-checkpoint-sha256 ...` with the explicit
`--expected-publication-checkpoint-absent` flag. A retained checkpoint from a
prior generation is supplied by its exact raw SHA-256; preview classifies and
binds it without changing its bytes.

The frozen mode accepts only the versioned ordered publisher stage contract.
Exactly one validation boundary may fail: contour failed with full tests still
pending, or contour completed/reused and full tests failed. Every
artifact/Git/runtime/worker/activation/extension effect stage must be pending
with no progress receipt. Checkpoint evidence must be the exact compatible
current pre-effect prefix, an exact scope-compatible prior-generation prefix,
or explicit absence. Unknown stages, mixed/foreign checkpoint scope, missing
candidate/run binding, unsupported schema or any effect receipt reject without
writing evidence.
Completed contour evidence requires a current checkpoint. A retained prior
checkpoint is accepted only when contour failed before writing it or the
producer recorded contour as reused from that exact compatible scope.

Record the returned `proofHash` and effect list. Confirmation repeats every
guard and uses the same operation ID and all the same arguments, plus:

```text
--confirm-recovery --expected-proof <preview-proofHash>
```

The exact live effects are limited to an append-only recovery evidence file,
the release checkpoint transitions `freezing|frozen` → `abandoning` → `abandoned`,
CAS restoration of the release clone's local `main` and `PreRelease` refs to
the values already stored in the freeze intent, and restoration of the clean
prepared `PreRelease` checkout. The command does not update a remote, publish,
deploy, install runtime bytes, mutate Tasks, remove the original manifest or
Git objects, or build another candidate.

Once `abandoning` is durable, retry the same operation ID, source identity,
arguments and proof. It resumes from stored evidence before fresh frozen-state
guards and never regenerates admission authority from refs changed by its own
prior commands. It accepts only the exact clean frozen, prepared-detached or
completed state. A remote advance after admission is tolerated only when the
frozen candidate is not its ancestor; publication of that candidate still
fails closed. A completed repeat returns the stored outcome without consulting
newer publication files.

After a confirmed outcome, build the replacement only through ordinary release
planning and `prepareCandidate`. The replacement plan must explicitly include
every intended accepted result, including the fix that supplied this recovery
owner. HUB-256 supplies the freeze payload fix and HUB-257 supplies this
recovery command; they are distinct Task results and neither is automatically
part of the previously authorized seven-Task release. Keep the durable published revision and an approved newer
`origin/main` as separate identities; the recovery command never equates them.
