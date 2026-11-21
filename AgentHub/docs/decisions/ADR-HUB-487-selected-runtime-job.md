# ADR-HUB-487 — Verify the installer against the retiring Hub Job

On Windows build 26300.10075, WMI reports successful suspended Python creation
with and without explicit breakaway, but the process is in a Job either way.
The native membership check shows the worker is outside the actual Ready Hub's
named Job. Direct creation and Task Scheduler on that host also produce
Job members.

Keep one WMI creation attempt, the exact suspended worker and caller security
checks, and the existing installation and retirement owners. When an ordinary
worker is in a Job, bind the selected Ready Host and Node by native identity,
verify both are in the exact per-Host Job, and prove the worker is outside it.
Retain the real Job membership and selected scope in all worker ownership
records. Recheck the scope before retiring the selected process tree. Do not
retire any unidentified new Host or the installer itself.

If the retire preflight finds a different Host, retain that refusal and skip
rollback and relaunch. Other recovery after scoped admission keeps the old
Host identity until the updater starts and pins its own exact replacement.

Retain the existing job-free route and the separate stopped-only installer.
An unproved runtime, unavailable Job, replaced Host or worker in the selected
Job still refuses before retirement. Previously retained original operations
and their unbound continuation policy keep their original requirements.
