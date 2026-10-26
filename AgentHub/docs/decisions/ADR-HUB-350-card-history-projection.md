# Task history outside board snapshots

The board list contains card metadata and checklist state, with a details revision.
It does not contain work-log entries, Git history or read journal record bodies.
Opening a card uses the existing authenticated control transport for one exact
Task read; only the open card retains full details. Late responses cannot change
another opening or a newer canonical revision. A changed details revision refreshes
the open card through the same read, without an additional polling owner.

The journal remains terminal-turn authority, and durable Task bindings remain
membership authority. A small derived SQL index is maintained in their existing
write transactions, including exact operation identities. No second journal,
background process, retry owner or authority cache is introduced. The one-time
transactional bootstrap runs only after both schemas exist. Subsequent journal
and binding writes update only the exact affected identities.
The same projection transactions advance one small revision counter per Task.
Board refresh reads those counters, without scanning or aggregating turn rows.

Terminal corrections replace the projection; provisional/nonterminal corrections
retract it. Journal retention does not erase already recorded Task history.
Removing a binding retracts its membership. Legacy work-log entries remain when
no projected terminal turn supersedes the same provider/thread/turn. Git custody,
release eligibility, immutable results and CAS do not derive from this index.

Read-only historical release evidence without the new index retains its existing
detail-read query. This migration compatibility is never used by a board list;
it can be removed when retained release-evidence databases have been migrated.

