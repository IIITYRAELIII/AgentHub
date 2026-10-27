# ADR-HUB-314: Correctness orchestration uses operation bounds

Date: 2026-10-26
Contracts: PERF-001, REL-001
Status: correction proposed for independent source review; application evidence separate

## Context

The prescribed GEN10 and GEN11 pipelines recorded Node-case cancellation at
60/90/180/240/300/360 seconds in native Git correctness scenarios. These timers
start before fixture creation and cover several repository operations, SQLite
transitions, refusals, archive/recovery and final assertions. They are not
product latency assertions. A single native operation can legitimately retain
its existing 120/300-second bound; several such operations cannot consistently
share a smaller aggregate stopwatch during resource-admitted validation.

The same unchanged archive scenario completed normally in addressed checks;
the paired metadata correction retained its assertions and reduced root Git
starts713->641 with44.868->41.852 seconds on that host. This does not prove a
specific historical disk/CPU cause. GEN11 also recorded only timer cancellation
for composition validation and local-source candidate reuse/freeze, rather than
an assertion or native-command timeout. Historical failures remain unchanged.

## Decision

Apply one policy to the entire native-Git correctness family: do not put a
whole-case stopwatch around fixture creation plus several independent Git,
SQLite, archive, recovery, refusal or cleanup operations. Scope comes from the
scenario's behavior and owners, not from whether that case already failed.
This includes native Task Test/Await, selected composition, public lifecycle,
installed adoption/history, preparation/preflight/generation, metadata paths,
bundle transport/retention and accepted-main/bootstrap/correction scenarios.
New cases in this family follow the same rule before their first failure.

Discover timeout metadata across every tracked test module before classifying
its owning behavior. Helper names, service spellings and directory names must
not exclude a real-Git publication or recovery scenario from that inventory.

The earlier correction covered52 case definitions and one nested whole-Node
command. GEN12 exposed that failure-selected coverage was incomplete: the
ordinary clone-transport case still cancelled at its90000ms aggregate timer.
The initial helper-name inventory found92 remaining aggregate definitions in20
native correctness files. Independent review found one more real-Git publication
case using a differently named helper. Remove all93 in21 files, retaining the
four Windows-only skip conditions and every case body. These93 definitions are
not claimed to have all timed out. The combined correction covers145 case
definitions; existing
loop expansion does not make this a count of unique executed runtime cases.
The already removed180-second nested whole-Node command covers multiple
authority scenarios, and remains separate from an operation deadline.

No replacement larger case deadline is introduced. Explicit single-command,
lease, readiness, network/build and protocol limits remain. In particular,
the120-second Worker dry-run execFile and10-second reconciliation CLI command
are retained; they are operation limits, not native-case metadata. Tests whose
purpose is a timed behavior keep that assertion/polling/gate. Unrelated config,
telemetry and E2E case limits are classified separately below.

GEN12 additionally exposed aggregate orchestration clocks outside the native-Git
family: a 60-second wrapper sequentially executes seven complete
validation files under the publisher lock; a 120-second wrapper prepares,
installs and verifies a packaged runtime before its separately bounded
30-second readiness check and original-owner preservation assertions. An AST
inventory of all1388 tracked executable modules finds206 remaining direct
Node-case options and125 other timeout properties, without a helper-name filter.
Semantic classification selects53 aggregate definitions in23 files: lifecycle
rotation, prepared/runtime and recording scenarios, cohort adoption/rollback,
transport/file-transfer correctness, production-factory wiring, native accounting
and nested validation. These53 are additional to the145 native definitions;
the combined policy covers198 definitions plus the separate nested-Node clock.
Loop definitions are not a count of executed runtime cases.

This explicitly extends the operation-bound rule to multi-operation correctness
orchestration. It does not claim those scenarios passed or permit unbounded
readiness. All actual inner startup, RPC, smoke/refusal, single-command, lease,
byte/memory and identity assertions remain. Recording retains its8-second
polling gates while removing only the25-second aggregate case metadata.
The inventory separately retains153 Node options:139 explicitly timed UI or
workload envelopes,8 sole-liveness/startup/protocol cases and6 real deadline/
termination controls. Some retained UI envelopes contain multiple actions;
they are not misrepresented as per-step SLOs. All125 non-case fields are kept.
This is not a blanket timeout deletion or a claim that the repository has no
aggregate watchdogs. New cases must classify their behavior before exclusion.

This refines ADR-0118's statement that test-local limits remain: actual bounded
commands, lease loss/cancellation semantics, readiness polling, output-idle
watchdog and explicitly timed behavior tests remain. It does not treat every
local stopwatch as a product requirement. In particular, production native Git
timeouts, protocol/operation bounds and ownership/cleanup guards are unchanged.
Direct fixture Git queries remain noninteractive fixture operations; this
change does not claim an additional command deadline where none existed.

All case bodies/helpers/fixtures and their CAS, origin, archive, UNKNOWN,
immutability and recovery assertions remain byte-identical outside the removed
timer options. Every required case still runs through the existing runner and
failure/checkpoint owner. No skip, assertion waiver, retry, successful-cache
invention, scheduler cap, resource-budget change, publisher or new release is
introduced. The ten-minute full-stage output-idle watchdog remains responsible
for an otherwise silent stuck owned test tree.

## Evidence and limits

The immutable GEN11 and GEN12 are not edited or retargeted. Exact-edit
manifests bind all198 scenario definitions and the separate nested
whole-Node timer. Inverse application reconstructs every entire original
test file, proving that fixtures, assertions and explicit operation
bounds are retained. The complete-family inventory classifies remaining
operation limits separately; it must not select only newly red cases. Syntax and independent review do
not establish a passing whole suite. The later ordinary Test/Await composition
and a new generation of the same prescribed pipeline must execute the cases
and verify the full outcome. Historical BITS handles and cancelled-child phases
remain unknown; their failures are not converted into success by this decision.
