# ReleaseOperation acceptance matrix

Run the coherent matrix with `npm run test:release-operation`. It exercises the
public command/MCP owners, real SQLite, isolated Git repositories and remotes,
an HTTP deployment endpoint, process death, durable recovery and legacy import.
No production credential, registered primary checkout, live release root or
runtime is used.

| Design scenario | Production entrypoint | Executable evidence |
| --- | --- | --- |
| 1. Two Await transitions and conflict | `TaskLifecycleService` → serialized live `prepareCandidate` → Task CAS | `task-await-prerelease-integration`: simultaneous acceptance reuses one PreRelease with a hooked primary, creates no temporary generations and retains both results; conflict and proven SQLite rejection restore the prior candidate |
| 2. G1 validation failure, R2, G2 | `ReleaseOperationCommandService` → `ReleaseOperationService` | fault matrix scenario 2 and `a correction accepted during validation fences G1 and publishes G2` |
| 3. Unrelated/newer Task result | publish-start reservation and exact finalization | fault matrix scenario 3, workspace adapter reservation tests, release-operation finalization tests |
| 4. Crash around durable local effects | public command owner plus SQLite receipts | fault matrix scenario 4 kills a real child process after the applied compose receipt; service/store recovery tests cover generation-before-receipt and owner fencing |
| 5. Lost external reply and partial targets | `ReleaseOperationPublication` → installed stable runner → frozen publication Git adapter | process-level test executes the stable runner against an exact SQLite generation and isolated bare remote; a second real-Git adapter test loses the reply after the actual leased push and proves one push; fault matrix scenario 5 and service tests preserve the partial-target vector and continue only missing targets |
| 6. Command, Thread and immediate ACK | MCP and desktop/CLI owners plus production Test Contour smoke | Hub MCP release tests, command service rejects inferred initiators, CLI supplies exact Stream/Thread, and `test-contour-scenario6.e2e.test.mjs` runs the real disposable Hub, Web UI, fake Codex and headless Edge against historical named/live unnamed Threads and an empty catalog; a queued ACK is followed by read-only exact receipt/turn readback, a definite refusal fails early, and an unknown outcome creates no second command/provider effect |
| 7. Raw EOL, release notes and wrapper replay | generation identity and thin CLI | fault matrix scenario 7, exact prepared CHANGELOG generation test, source-line-ending tests, deterministic `publish:changed --resume` CLI test |
| 8. Dead owner/takeover and short CAS | lease epoch fencing and Await owner | process-death scenario 4, store stale-epoch test, long-validation heartbeat tests, Await integration |
| 9. External outage | durable `waiting` plus retry timer | fault matrix scenario 9 and autonomous outbox retry test |
| 10. Runner N to N+1 | stable installed runner and N-1 SQLite operation store | runtime manager test interrupts N+1 after stable-file staging but before pointer commit, proves runner N and its active SQLite operation remain authoritative, then retries the exact prepared install and reopens the N operation under N+1; publication spawn/early-exit and actual `runStep` candidate-cwd tests cover the adjacent process boundary |
| 11. Bounded validation failure | classified wait without hidden suite retry | fault matrix scenario 11 and validation correction service test |
| 12. Legacy states and historical incidents | startup legacy importer | fault matrix scenario 12 imports exact retained 028b/0e7272 artifacts as evidence-only operations, runs normal recovery, and proves the isolated Git/deploy endpoints receive no new external call; legacy importer tests cover active legacy states |
| 13(b). Unrelated R2 and automatic correction | generation lineage producer → canonical Task lifecycle correction → same ReleaseOperation | real-Git lineage test rejects the unrelated result with `RELEASE_RESULT_LINEAGE_MISMATCH`; service test creates one correction request and resumes the same operation; corrected candidate proves obsolete R1 bytes absent and neighboring Task bytes preserved |

The application-state fault matrix uses real Git and SQLite but substitutes
deterministic validation/deployment implementations at those application ports;
it is not publication-path evidence by itself. Separate executable publication,
filesystem, Await and CLI tests in the same command exercise the production
adapters, subprocess boundary, candidate working directory, exact metadata and
spawn/readback races that the callback matrix cannot observe. The historical fixture preserves the
exact incident identities and external-effect boundary; the self-contained
legacy importer tests use equivalent isolated manifests rather than copying
machine-specific release paths into the repository.

Passing this command proves the enumerated isolated fault behavior. It does not
claim that an unavailable real remote has recovered, that production was
published, or that historical source bytes were reconstructed from metadata.
