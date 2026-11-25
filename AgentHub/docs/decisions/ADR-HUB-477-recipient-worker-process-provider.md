# ADR-HUB-477 — Recipient worker Windows creation

The public 2.1.10 recipient selected the desktop shell as its native parent.
Windows inherits that parent's Job. The recipient then checked membership in
any Job, but described every refusal as failure to leave the old Hub Job.
The user screenshot reports that refusal; it does not establish the actual
machine's Job owner. A successful run with an outside-Job Explorer is a different
environment. Shell/scheduler attempts alone are not independence evidence.

The common recipient now uses one local Windows process-provider invocation:
`Win32_Process.Create` with `CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED`.
Explicit breakaway matters because the provider itself can have a quota Job.
The provider receives command/path/environment as JSON data, not shell code.
There is no Explorer dependency, scheduled task, permanent service or fallback.
Failure does not start a second attempt or weaken native membership validation.

Before Resume, the existing dispatcher verifies fresh native birth, exact Python
image and command, a still-live retained process handle, identical user/logon/
session/elevation, absence of every Job, and one exact native thread. Refusal
joins only its positively identified worker; unknown/reused identities never
grant a kill. The worker repeats outside-Job verification before owning effects.
Original request, provider result, native suspended proof and failure timing are
retained before normal logging. Lost response uses existing original readback.

Selected-runtime native retirement, both permanent modes, data/queue retention,
backup, one replacement, Ready and previous-version rollback retain their owners.
This changes only the common recipient, not RuntimeHost native replacement.

References: [process creation](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process),
[startup flags](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processstartup),
[parent attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).
