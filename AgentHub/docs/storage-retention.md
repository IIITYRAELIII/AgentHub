# Native storage retention

Normal installed Hub startup schedules policy v1 after readiness and periodically
every six hours. The installer does not start the application to run cleanup.
No per-user external scheduled task or Codex automation is required. Test Contour,
recording, release acceptance and development runtimes do not run production
cleanup. Active user turns defer admission.

The health diagnostic `storageRetention` reads cached bounded status only. It
reports policy version, discovery completion, pending original intents, removed
transport count, observed prior removals and retention reasons. Status/Task/board
reads do not open the cleanup store or enumerate files. Durable child outcomes
retain the preview, original identity, logical bytes and free-before/free-after
observations. A free-space delta can include concurrent allocations and is not
a physical allocation estimate based on summed logical file sizes.

The first owner handles redundant `task-native-merges/*/source.bundle` only when
the Task is completed and its existing publication owner proves the exact
result/current work published. Its independent repository must be full, clean,
connected and free of borrowed objects. The bundle's advertised heads are retained
in the original maintenance intent. Repositories, refs, merge journals, WIP,
attachments and historical results are preserved. An open, dirty, unpublished,
unknown, changed, oversized or unsupported artifact is retained with a reason.

Each pass has at most three units and a cooperative 20-second admission budget.
Hashing/deleting one admitted transport may finish later; shutdown drains the
actual owner and does not pretend a timed-out child stopped. Discovery is a flat
owner-directory read, not a recursive archive/history scan. A lost reply is
reconciled through the same operation. Unknown present files are preserved;
there is no retry that invents a fresh deletion identity.

New native merge transport excludes unrelated source refs. Existing large broad
transports become eligible only under the same completed/published owner checks.
Other legacy archives, fixture directories, runtime versions and dependency trees
are not newly authorized by policy v1. The implementation must add their existing
owners' previews and retirement proofs before expanding automatic deletion.
See [ADR-0126](decisions/ADR-0126-owned-background-storage-retention.md).

Focused validation from AgentHub:

```text
node --no-warnings --test tests/application/storage-retention-service.test.mjs tests/composition/storage-retention-composition.test.mjs tests/infrastructure/filesystem/native-merge-transport-retention.test.mjs tests/infrastructure/filesystem/sealed-transport-delete.test.mjs tests/infrastructure/filesystem/selected-git-bundle.test.mjs
node --no-warnings --test --test-name-pattern="cleanup preserves ignored WIP|published cleanup|isolated native merge|native Test retains" tests/infrastructure/filesystem/task-git-workspace.test.mjs
```

Windows fixtures exercise actual native deletion and real Git transport. Use an
isolated disposable TEMP/TMP directory on the intended fixture volume. Tests do
not read/delete the installation's original migration cohort.

Native API references: [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex),
[FILE_STREAM_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_stream_info),
[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).
Git's [rev-list --quiet](https://git-scm.com/docs/git-rev-list) tests object
connectivity without printing a full object inventory.
