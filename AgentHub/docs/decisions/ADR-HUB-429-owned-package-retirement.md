# ADR-HUB-429 — Original-bound native package retirement

## Context

The 2.1.6 update's old native attempt rejected Job retirement after old Node and
Host exit. Its historical remaining reference holder is unknown. Operational
recovery later installed successfully. Host verification took about 45 seconds
and subsequent startup about 100 seconds, exceeding one 120-second observation
from Host launch. Installed release continuation also lacked an explicit
external tool root after replacement.

## Decision

Use the existing maintenance original, native Host, root gate, backup and public
installer. Native admission captures exact old process handles, births and Job
membership outside every Job. Complete PID enumeration and signalled kernel
handles prove writer closure. A durable exact-original forced-stop intent
precedes TerminateJobObject on the held installation Job after bounded graceful
retirement. Unknown or foreign evidence refuses. No provider text/timer is
treated as process identity or proof of completion.

Protocol1 installed sources keep their original old controller and executor.
The incoming verified package separately admits its independent native observer
before the initiating turn yields. It releases the root gate while waiting for
old native closure. A positively closed pre-backup attempt permits a new durable
recovery intent retaining the entire prior row and binding. An install or launch
intent never qualifies for this continuation. Remove compatibility when all
supported installed sources accept an incoming native executor before arm.

Manifest verification/Host admission and Node Ready have separate observation
budgets. The same launch and maintenance original survive lost observation.
Startup can later settle that original. Definitive joined installer failure
uses existing verified previous-current recovery. Unknown effects never grant
another install or launch.

Record the verified immutable external tool's physical root, directory identity
and whole runtime digest in the original runner before effects. Replacement
owners resolve only this binding. Historical runners without it require an
explicit original-compatible pin. A narrow generic failed-publication recovery
boundary retains failed receipts, partial effects and frozen generation. The
product adapter must positively verify original public assets and the same
successful installed consumer/Ready under installation custody before admission.
It resumes remaining checkpoints without re-running INSTALL or composition.

## Evidence and limits

Maintained tests cover kernel Job/handle closure, bounded forced stop and foreign
negatives, separate admission/Ready phases, durable tool directory replacement,
and real SQLite same-generation recovery. Full inside-Hub public installer
acceptance and independent review remain required for delivery. Fixture outcomes
do not establish the historical holder, public transport or unattended production
survival. Existing 2.1.6 artifacts and original histories remain immutable.

Windows counts Job ActiveProcesses until process exit and reference release.
A terminated process object becomes signalled while handles may still remain
valid. These properties motivate the explicit kernel proof.
[Job accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
[Job PID list](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list)
[Process termination](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process)
