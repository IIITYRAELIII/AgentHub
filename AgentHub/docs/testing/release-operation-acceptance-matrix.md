# ReleaseOperation acceptance matrix

Run the coherent matrix with `npm run test:release-operation`. It exercises the
public command/MCP owners, real SQLite, isolated Git repositories and remotes,
an HTTP deployment endpoint, process death, durable recovery and legacy import.
No production credential, registered primary checkout, live release root or
runtime is used.

| Design scenario | Production entrypoint | Executable evidence |
| --- | --- | --- |
| 1. Two Await transitions and conflict | `TaskLifecycleService` → independent `prepareGeneration` → short `promoteGenerationCandidate` CAS | `task-await-prerelease-integration`: simultaneous acceptance uses distinct generation roots, stale loser recomposes, final live PreRelease contains both results; conflict remains before Task CAS |
| 2. G1 validation failure, R2, G2 | `ReleaseOperationCommandService` → `ReleaseOperationService` | fault matrix scenario 2 and `a correction accepted during validation fences G1 and publishes G2` |
| 3. Unrelated/newer Task result | publish-start reservation and exact finalization | fault matrix scenario 3, workspace adapter reservation tests, release-operation finalization tests |
| 4. Crash around durable local effects | public command owner plus SQLite receipts | fault matrix scenario 4 kills a real child process after the applied compose receipt; service/store recovery tests cover generation-before-receipt and owner fencing |
| 5. Lost external reply and partial targets | `ReleaseOperationPublication` readback | fault matrix scenario 5 and publication/service partial-target tests |
| 6. Command, Thread and immediate ACK | MCP and desktop/CLI owners | Hub MCP release tests, command service rejects inferred initiators, CLI supplies exact Stream/Thread, desktop router delegation and ACK tests |
| 7. Raw EOL, release notes and wrapper replay | generation identity and thin CLI | fault matrix scenario 7, exact prepared CHANGELOG generation test, source-line-ending tests, deterministic `publish:changed --resume` CLI test |
| 8. Dead owner/takeover and short CAS | lease epoch fencing and Await owner | process-death scenario 4, store stale-epoch test, long-validation heartbeat tests, Await integration |
| 9. External outage | durable `waiting` plus retry timer | fault matrix scenario 9 and autonomous outbox retry test |
| 10. Runner N to N+1 | stable installed runner and N-1 SQLite schema | fault matrix scenario 10, publication spawn/early-exit tests, actual `runStep` candidate-cwd test, runtime packaging test |
| 11. Bounded validation failure | classified wait without hidden suite retry | fault matrix scenario 11 and validation correction service test |
| 12. Legacy states and historical incidents | startup legacy importer | fault matrix scenario 12, legacy importer tests, and exact saved 028b/0e7272 readback identities in `tests/fixtures/release-operation-historical-evidence.json` |

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
