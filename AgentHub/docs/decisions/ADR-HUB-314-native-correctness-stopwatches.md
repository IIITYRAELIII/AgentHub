# ADR-HUB-314: Native Git correctness uses operation bounds

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

Remove aggregate test-case timeout options from37 directly cancelled
correctness definitions. For the recorded late-native-history failure, also
remove its related outer240-second and called300-second Node-case timers,
alongside the180-second execFile timer that actually terminated the nested
Node test. That command contains two full authority scenarios. Its environment,
observer, output framing, maxBuffer and all original assertions remain.
The related240/300-second timers are not falsely reported as having fired in
that original observation. No replacement larger deadline is introduced.

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

The immutable GEN11 is not edited or retargeted. The exact-edit manifest binds
the39 scenario definitions and one nested whole-Node timer; inverse application
reconstructs every entire original test file. Syntax and independent review do
not establish a passing whole suite. The later ordinary Test/Await composition
and a new generation of the same prescribed pipeline must execute the cases
and verify the full outcome. Historical BITS handles and cancelled-child phases
remain unknown; their failures are not converted into success by this decision.
