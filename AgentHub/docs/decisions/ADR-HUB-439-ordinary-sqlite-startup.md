# ADR-HUB-439 — Ordinary SQLite startup without inspection

The user explicitly removed mandatory database copying and integrity checking
from ordinary startup. The former path copied the complete DB/WAL and ran
quick_check even when no recovery was pending.

The existing recovery coordinator now returns after reading absent marker and
intent metadata. Existing storage owners open the database and propagate their
real errors. An ordinary opening error grants no quarantine/replacement action.
The startup operation is labelled "Подготовка данных" rather than an integrity
check. Existing startup tracing and readiness owners remain unchanged.

Previously persisted markers and interrupted intents retain their existing
validation, rollback, inspection, quarantine, restart and acknowledgement path.
No new recovery trigger, background check, command or setting is introduced.

Behavioral evidence covers ordinary DB/WAL byte preservation without inspection,
actual storage/composition opening failure, and the retained saved-recovery
fault, worker, trace and startup-shell cases. Small fixture timings establish
only that measured path, not a production startup latency guarantee.
