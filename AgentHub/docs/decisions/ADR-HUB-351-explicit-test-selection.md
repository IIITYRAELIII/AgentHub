# ADR-HUB-351 — Explicit release test selection

Status: accepted with this implementation, 2026-10-26.

The user requested machine-readable all/only selected/all except selected/none
through the existing runner and original release operation. A failed full run
remains failed even when the next generation is explicitly authorized without
tests. Focused/quick are not none.

Keep original authorization immutable. An RM continuation appends a request-
addressed test-selection amendment using operation revision + current-generation
CAS, after the existing publication readback proves each original target
not-applied and the release owner is idle. Prior state/error/completion, wait
state and publication boundary are retained in that amendment. Existing
reviewed-main recovery remains separate; partial/unknown effects do not acquire
no-effect credit. The same owner/store/event transaction schedules normal compose.

New generations optionally bind repository-scoped inventories and effective
plans. Old generation identities and default authorization serializations are
unchanged. Exact file IDs include the existing E2E and VS Code groups,
`syntax-check.mjs`, `install_test.py`; optional profile variants use
`profile:<profile>:<file>`. Publication checks have explicit IDs
`check:release-candidate`, `check:contour`, `check:worker`. Explicit all includes
these optional variants; omission retains the ordinary prescribed policy.

The generation runner verifies inventory against the exact candidate. Explicit
plans replace only validation steps; builds/push/install/readiness retain their
existing owner. Manual file selection calls Node test-suite directly, avoiding
implicit npm pretest expansion. The existing per-file process/temp/cwd/resource/
checkpoint machinery runs only selected IDs. None starts no test child and writes
no successful-cache fact. A selection digest scopes checkpoints and publication
identity. Not-selected is distinct from passed, reused, skipped and failed.

Agent interfaces (from AgentHub directory):

- `node test-suite.mjs --list-tests` lists inventory, without execution.
- `node test-suite.mjs --plan-tests='{"mode":"include","ids":["tests/domain/release-operation.test.mjs"]}'` prints the effective plan.
- `node test-suite.mjs selected --selection='{"mode":"include","ids":["tests/domain/release-operation.test.mjs"]}'` runs exactly those file IDs.
- Existing `publish:changed -- --resume --operation <original> --validation=none`
  amends and continues that original; `--test-selection=<JSON>` supports all four
  modes. No `--full-tests`/quick/contour flag can silently override an explicit plan.
- Existing MCP `hub_release_continue` takes `operation_id`, unique `request_id`,
  `expected_revision`, `expected_generation`, and
  `test_selection:{"mode":"none","ids":[]}`. Read the current original first.

Do not invoke a publisher merely to test this API. Source acceptance is not actual
application or proof of publication. The release manager applies reviewed source
and uses the same original operation under its existing authorization.

The same optional amendment can carry explicit `task_ids` (CLI `--task-ids=<JSON array>`).
Only the existing Await/preflight owner verifies those exact IDs and accepted
result/composition identities under its transition boundary, then rechecks them
after publication readback and immediately before the operation CAS. Unknown,
foreign, unaccepted, missing or changed membership refuses. Initial authorization
is retained. Composition/reservation use the effective IDs; the next generation
freezes `authorizedTaskIds` and must contain exactly those selected results. The
existing Task-operation index retains historical membership for retrospective
proof, while active correction wake filters by the effective set. No all-Await
expansion, absorption, hidden source import or new publisher is implied.

Historical reviewed-main recovery keeps the exact membership of its own
priorRevision/priorGeneration boundary. A later membership amendment cannot
invalidate, retarget or rewrite that proof. Recovery after a membership amendment
validates the membership that was effective at that later recovery boundary;
its origin/authorization/hash/readback fences remain unchanged.

Each new amendment captures normalized requestArguments before resolving
omissions. Replay compares that original explicit/omitted argument identity and
returns its saved amendment and committed revision without a write or scheduling.
Older retained amendments without argument capture resolve omissions only against
their own saved outcome, never against a later effective selection; their bytes
and identity stay unchanged. No stored record is enriched during readback.
