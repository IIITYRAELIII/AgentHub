# Recurring Agent Hub errors

Use this registry when changing Agent Hub. Find the entry that matches the
affected boundary, then use its check to verify the fix. Keep the R-numbers
stable so reviews can refer to the same lesson. Add a pattern after independent
occurrences establish the mechanism. Keep private evidence in the local audit
and describe the mechanism here using synthetic examples.

- [Delivery and queues](#delivery-and-queues)
- [Projection, history and interface](#projection-history-and-interface)
- [Persistence, timing and execution](#persistence-timing-and-execution)
- [Git, release and installation](#git-release-and-installation)
- [Verification and tooling](#verification-and-tooling)

## Delivery and queues

### R02. An old turn keeps the queue busy
Remove old-turn recovery from startup, retries and observers. The local execution
owner retires its binding before freeing the lane and preserves history, receipts,
attachments and queued input. An independently live foreign turn stays with its
owner and is never adopted or terminated automatically. Test a cold start with
an unavailable old turn and a live foreign turn. Verify that new input proceeds
without replay or a fabricated provider result.

### R03. Intake, provider acceptance and rendering are conflated
Keep the Hub receipt, provider acceptance and display as separate facts. Reconcile
a lost receipt by its original ID. Test acceptance before the intake acknowledgement,
a late acknowledgement, a render failure and reload without a revived queue card.

### R04. Context maintenance overtakes user input
Coordinate maintenance and admission using the same Thread and exact user turn.
Exercise completion, compaction or rotation, then dispatch, with a lost response
between stages. Verify that the original input is neither lost nor replayed.

### R05. Dispatch uses the wrong mode, order or steer target
Preserve the chosen delivery mode and resolve the current turn at dispatch.
Check a paused FIFO head, a steer behind a queued next turn, and a target change.
Retain the original request ID when the new target is unavailable.

### R07. Message identity or origin disappears
Carry client, submission and provider item IDs through parsing, storage and
rendering. Establish origin from verified durable metadata before normalizing
text. Leave textual envelopes without proof literal and keep empty provider
item IDs out of shared identity keys. Test identical messages with different
IDs, missing item IDs, cross-Stream and native input, attachments and cold reload.

### R21. A rotated Stream still targets its old Thread
Resolve the logical Stream to its current Thread at the routing owner. Rebind
source and destination views after rotation. Test an old bookmark and a tab open
during rotation, including retry of the same request.

### R23. Completion is saved while delivery of the final or projection fails
Persist the canonical final and make journal, usage and view delivery resumable by
the existing owner. Keep commentary distinct from final and retain interrupted
partial output. Verify phase, body and item ID after history handoff and reload.
Exercise terminal before final body, reconnect and SQLite contention with recovery.
Expect one derived record for the original turn.

### R31. A partial durable transition is treated as complete
Track reservation, effect and remaining persistence or cleanup separately.
Recover at the saved phase under the original ID. Interrupt each phase and
verify that completed effects stay single and required input remains available.

## Projection, history and interface

### R06. A stale snapshot rolls back terminal state
Apply confirmed terminal identities and revisions monotonically and preserve the
final before clearing live state. Test a late running snapshot after completion.
An incomplete snapshot must also leave a genuinely active turn intact.

### R20. A projection invents timestamps and reorders history
Keep submission and execution timestamps separate and preserve unknown values.
Verify order and anchors through queue acknowledgement, a legacy null timestamp,
older-page loading, hydration and reload.

### R29. A migration skips retained legacy data
The migration owner tracks the source layout, actual record shapes and durable
cursor. Test legacy rows, several files for one Thread, unchanged content with a
changed layout, and a cold restart through the same migration.

### R30. An adapter expects an obsolete provider format
Bind parsing to observed provider event shapes. Keep unknown events diagnosable.
Check current and legacy events, including maintenance completion and image
captions, through the final user-visible projection.

### R32. A style declaration is mistaken for rendered geometry
Fix the owning cascade, sizing rule or token. Check computed geometry with
contrasting themes, dense content and a small viewport. For animations, verify
the loaded surface and its document policy across several frames.

### R33. A filter or limit excludes the requested data
Apply scope for the current request at the query or projection owner. Verify an
explicit item outside a peer limit, a mixed-provider Stream, and separate scoped
and unscoped accounting views.

### R34. A snapshot erases a manual interface choice
Keep initial defaults, explicit client choices and incoming snapshots distinct.
Test collapse, selection and scroll through a late snapshot, new messages,
reload and Task changes on desktop and mobile.

### R35. A model is only partly wired into usage accounting
Carry canonical model identity through one pricing owner and its consumers.
Test input, cache and output charges in the journal, statistics and turn summary.
An unknown model keeps its unresolved price. Preserve historical amounts.

### R40. A bad cycle boundary drops new usage
Identify a genuine rollover using the recorded window or reset evidence. Test
rollover with an equal or higher percentage, an early reset followed by new
usage, and totals spanning two windows.

### R45. A partial update overwrites a full projection
Preserve confirmed fields when an update omits them. Rebuild only from the full
canonical inputs, including sync data. Test partial hydration, save and reload,
and a subsequent rebuild with existing records.

## Persistence, timing and execution

### R01. A database write failure obscures an earlier effect
Retry only the SQL callback through the existing writer with the original
operation ID and revision. Test a busy SQLite database after an external effect:
one effect, a durable terminal result and refusal after revision drift.

### R08. Heavy I/O blocks an interactive operation
Persist required receipts promptly and move optional hydration off the critical
path. Use a targeted read or a real incremental cursor. Measure queue, I/O,
commit and client paint by original ID, including independent Stop or another Stream.

### R19. Process replacement leaves descendants or admission active
The cutover owner coordinates admission and proves the old process tree retired
before backup. Check new input at the boundary, caller exit, descendants and PID
reuse. Read back the new Ready state or the verified previous runtime.

### R25. Immutable receipt rules are reused for mutable diagnostics
Keep receipts immutable. Use the intended streaming reader for large pinned
records and the existing append or snapshot path for progress. Test a second
write and an observer failure after an effect without repeating the effect.

### R26. An asynchronous continuation applies a stale decision
Capture exact target identity before waiting and recheck it at the mutation.
The durable writer merges with the current saved fields or checks the revision
at commit. Wait for workers outside SQL. Exercise selection changes, a new
active run and two writes that finish in reverse order.

### R28. The current directory replaces the session's creation context
Keep the project, current cwd and provider lookup context separate. Resolve the
same session after a directory change, rename or restart. Test both root and
nested-directory creation with retained history and queue.

### R36. Extraction breaks startup wiring
Place dependencies in the existing composition root according to when callers
need them. Test the real startup entry point to Ready, including the changed
callbacks and early restore paths.

### R37. A new module dependency creates an import cycle
Wire runtime services at composition and keep shared validation with its lower
owner. Inspect the actual dependency graph and compare to the parent to isolate
the new edge.

### R41. The primary error is lost before logging starts
Capture the bounded original failure, stage and operation ID before logger
startup where necessary. Test failures before logging, state save or locks and
verify the original result remains readable after a successful retry.

### R42. A SQLite file hash is taken as proof of WAL state
Use the existing logical reader or consistent backup owner. Verify records that
exist only in the WAL while main-file bytes stay unchanged. Use immutable mode
only with a proven immutable snapshot.

### R43. Callers acquire queues and locks in opposite orders
Use one acquisition order across callers. Release a resource before waiting
on work that needs it. Force the competing order with barriers and verify
progress plus serialization of the actual writes.

### R50. Repeated lease reads dominate Task transitions
Measure wall time by original ID and distinguish acquisition wait, Git child
lifetime and nested owner I/O. Remove redundant work at the owning layer while
retaining fresh checks between effects. Test exact output and lease loss.

## Git, release and installation

### R10. A merge drops an import, binding or dependency
Check the actual merged tree and the affected runtime route, including both
conflict sides and preserved automatic entries. Exercise the broken combined
tree and its correction on the same behavior.

### R11. The runtime package omits imports or companion files
Include runtime dependencies through the package owner. Inspect the built archive
and run the affected entry point from it. Test missing companion refusal and
verify the executing producer identity.

### R12. Source, build or publication is taken as installed proof
Track source review, built and published bytes, installer result, loaded runtime
and client separately. Upgrade a running old version with the actual distributable
and verify exact source, Ready and the affected action.

### R13. Manual delivery leaves Tasks open
Verify installed and published identities, then complete the supported Done and
closure operations with exact inputs. Exercise Await to Done using real delivery
proof and verify retained source and any unique work.

### R14. Nested Windows operations exceed path limits
Carry the existing Git long-path configuration across child and transport
boundaries. Use a short owned location for other tools where needed. Check a
long-path native Git operation, an actual SQLite backup and retry path length.

### R15. A new copy falls outside cleanup ownership
Record physical identity and scope before creating a copy and hand that evidence
to the storage owner. Test success, failure and a lost reply, then verify the
original cleanup receipt and actual storage. Keep ambiguous and foreign copies.

### R16. Git composition loses accepted content
Bind selection and parent order to exact bases and tree entries, including mode,
type and binary content. Prove any allowed omission and check the whole accepted
result. The originating protocol determines required selection and review proof
even when a projection makes the field optional. Carry proof from the adapter
through the durable result to its consumer. Match its identity before accepting
a duplicate or reusing a result. Test matching, missing and mismatched proof
for the same tree, and native resolution on a real graph with divergent bases,
later additions and dropped accepted bytes.

### R44. A Task operation uses the wrong Git project
Resolve the active executor's project through the existing Task Git owner, and
retain the issued managed root and original operation binding. Verify Claim,
Start, status and Await across UI and MCP with different caller, executor and
historical Thread contexts.

### R46. A Git command acts in a different checkout than the one verified
Pass the exact root to Git and verify branch, expected HEAD and index in that
same invocation path. Test that a mismatched root refuses before a mutation.
Confirm that unrelated roots and dirty files retain their contents.

### R51. A portable installation is rejected for missing a local source path
Verify the installed manifest against its retained prepared provenance and the
exact source and Host, then reread installation identity. Test a portable Ready
installation with the path omitted and rejection of a substituted manifest.

### R52. Active Git cleanup is mistaken for a lost owner
Distinguish a live cleanup process guard from an orphan using native identity and
the exact repository. Check Claim and Test while cleanup is live, then after it
finishes. Preserve the repository and the original cleanup receipt.

### R53. Archive cleanup repeats full delivery verification per branch
Measure delivery verification separately from branch cleanup. Carry exact
preview/confirm evidence through the existing owner and revalidate it before
effects. Test several branches, publication drift and preservation of unique work.

### R54. Windows Job membership binds the installer worker to another process
A successful process creation call is only one stage. Check exact suspended
worker identity and independence before Resume, and join only the verified
worker on refusal. Test with a real Windows Job, an old installation and data
preservation through recovery.

## Verification and tooling

### R09. A passing test exercises the wrong signal
Reproduce the real action with production-shaped input and its executing owner.
Exercise the exact failing baseline, the correction and a negative control.
Keep source, process exit, rendered behavior and loaded version distinct.

### R17. A rule is applied outside its scope
Check the active request, owner and explicit user decisions at handoff. Change
raw rules through their owning source. Test that the intended case receives
the rule and that unrelated work carries on normally.

### R18. A Windows launcher corrupts text encoding
Verify decoding through the real executable, including fallback launchers. Test
non-ASCII text and paths end to end, using structured arguments or an explicitly
encoded file where supported.

### R22. A diagnosis refers to a different object or revision
Bind the actual Workspace, Stream, Thread, turn and loaded version as applicable.
Use the exact contradictory readback to discard a stale hypothesis. Test a
same-name neighbor and the original symptom on the affected object.

### R24. Truncated output hides a verification gap
Read in bounded parts with observable end markers. Record contiguous coverage
and resume from the first unread part. Keep integrity checks distinct from
reading and interpreting the content.

### R27. An isolated test inherits production settings
Provide owned runtime, data and log locations and pass only needed environment
variables. Verify resolved paths and the transport with an inherited production
setting present in the parent process.

### R38. A tool timeout is mistaken for a product failure
Separate the tool's reply deadline from child lifetime. Check the original
process identity, exit, close and joined children before repeating anything.
A transport error still requires the result of the original assertion.

### R39. A full suite is repeated in place of affected checks
Select the failed and affected checks explicitly. Use the previous results for
successful unaffected cases and verify child settlement before a retry. Record
the selected commands and preserve the original failure.

### R47. A successful final command hides an earlier failure
Check each required native exit before proceeding. Test an earlier failure
followed by a successful later command and verify that the overall result
reports the earlier failure and any effects already applied.

### R48. A Windows search treats a glob as a literal path
Pass an existing directory with a filter such as `rg -g '*.mjs' pattern dir`.
Verify actual argv, exit status and covered files. Treat a path error as a
failed search.

### R49. A PowerShell variable collides with the built-in PID
Use a distinct variable for the target process ID. Test failed process lookup
and verify that a command never treats the shell's `$PID` as the target.
