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

If `origin/main` advanced after the candidate was frozen, failed-frozen recovery
does not rewrite the immutable `--expected-origin-main`. That value remains the
candidate's approved origin base. A separately reviewed, single-commit
fast-forward may be supplied only with the complete additional identity:

```text
--expected-reviewed-origin-main <commit> --expected-reviewed-origin-parent <approved-origin-commit> --expected-reviewed-origin-tree <tree> --expected-reviewed-origin-diff-sha256 <sha256> --expected-reviewed-origin-diff-hash-object <git-object-id> --expected-reviewed-origin-patch-id <patch-id> --expected-release-tracking-origin-main <commit> --expected-origin-url-sha256 <sha256>
```

The owner imports the live remote tip and frozen candidate into a disposable
bare object store. It proves the exact parent, tree, binary-diff SHA-256 and
  Git object ID and stable patch ID, proves the frozen candidate is not contained
  in the remote tip, and deletes the store afterward. It never fetches into or moves the release
clone's refs. The live remote, unchanged release tracking ref and origin URL are
bound into preview/evidence and must remain exact through confirmation and every
retry. Divergence, force-push, unreviewed bytes or later movement fails closed.
This observation neither changes the durable published baseline nor adopts the
reviewed upstream bytes; an ordinary future candidate rebuild retains them
through the normal reviewed-main path.

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
An existing prior checkpoint must contain a non-empty ordered pre-effect prefix
and a non-empty fingerprint for every completed label; use the explicit absence
flag only when the checkpoint file genuinely does not exist.

A failed-frozen candidate whose immutable manifest and checkpoint both lack
base provenance and a preflight request ID cannot satisfy
`--expected-origin-main` from its own evidence. The explicit supplemental
`missing-provenance-recovery-v1` input never repairs that candidate:

```text
--missing-provenance-recovery missing-provenance-recovery-v1 --preflight-request-id <original-preflight-request-id> --preflight-arguments-file <exact-original-arguments-json> --expected-preflight-arguments-hash <receipt-arguments-sha256> --expected-preflight-result-sha256 <canonical-result-sha256> --expected-preflight-stream <stream-id> --expected-preflight-provider <provider> --expected-preflight-thread <thread-id> --expected-adoption-task <task-id> --expected-adoption-ref <refs/agent-hub/upstream-adoptions/...> --expected-adoption-blob <blob-id>
```

The arguments file holds the exact original `hub_release_preflight` arguments
without `context_token`; it is accepted only when the shared MCP canonical hash
reproduces the durable receipt's own `argumentsHash`. The owner re-reads the
terminal succeeded, non-compacted receipt from `WorkspaceCatalogStore` and the
selected Task adoption through `TaskGitWorkspaceService.releaseBaseEvidence`.
The ready result must describe exactly this repository, plan, Task set and the
prepared source of the frozen manifest; the approved published/local/origin
tuple is derived from those authorities, never from `baseCommit`, current refs
or Task state. The resulting `supplemental-reviewed-adoption-v1` authority,
the prepared manifest bytes and the full receipt result are content-addressed in
the recovery proof and evidence; the old candidate is not relabelled as
`explicit-reviewed-main-v1` and its bytes are unchanged. Preview, confirmation,
resume and completed replay re-read both authorities before any return or ref
effect; omitted or changed supplemental input on an admitted operation rejects.

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
