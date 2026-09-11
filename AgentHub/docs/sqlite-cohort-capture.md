# Process-owned SQLite cohort capture

Use `captureSqliteCohortInProcess` from `src/runtime/sqlite-cohort-capture-process.mjs` for a real capture. The lower-level `captureSqliteCohort` is used by its worker and synthetic tests; it is not a deadline-safe production entry point by itself.

The supervisor requires explicit absolute, non-overlapping source and output directories. It creates a new owned output root, persists the worker PID, then permits the worker to open the three databases. Source DB connections, retained read transactions, online backups and stream hashing all live in the worker. The supervisor has no SQLite handles and performs no bulk hashing.

The monotonic work deadline defaults to 120 seconds and includes worker startup, pinning, all three backups and hashing. Cancellation or deadline expiry sends `SIGKILL` to the owned child process handle. The supervisor waits for the process `close` event before reporting confirmed cleanup or touching the child's capture manifest. An early worker error message does not disarm the watchdog while the process remains alive.

If the OS does not confirm termination within the separate five-second termination deadline, the operation returns `CAPTURE_TERMINATION_UNCONFIRMED`, with `workerExitConfirmed:false`. Its output stays quarantined and the capture manifest is not rewritten concurrently with a potentially live worker. This is an explicit failure requiring process investigation, not successful timeout cleanup. The implementation does not claim an OS kill guarantee when termination fails.

Only worker exit with code zero, an exact result path and a completed raw manifest count as a completed capture. All results remain `bootable:false`: capture is not sanitization or runtime acceptance. Confirmed failures mark both supervision and any partial capture manifest failed. Partial raw databases remain in their owned directory for diagnosis; they are never installed into a runtime. Do not delete or promote an unconfirmed-termination directory while its process may still be alive.

```javascript
import { captureSqliteCohortInProcess } from "./src/runtime/sqlite-cohort-capture-process.mjs";

const result = await captureSqliteCohortInProcess({
  sourceDataDirectory: process.env.SOURCE_DATA_DIRECTORY,
  outputDirectory: process.env.SNAPSHOT_OUTPUT_DIRECTORY,
  deadlineMs: 120_000,
  includeQueueFiles: true,
  signal: abortController.signal,
});
```

The cohort invariant remains unchanged: independent observers compare their own `data_version` before and after all read pins. Unchanged versions establish a common read window. A conflicting commit retries all three pins together. Online backup reads those retained transactions; no live SHM is copied. The capture is not a flush of pending application writes or an atomic transaction across domain stores.

With `includeQueueFiles:true`, the same supervised child reads `delivery-outbox` and `background-jobs` before pinning and verifies their inventory, file identity and SHA256 again before releasing the pins. A changed or newly created queue directory or record rejects the whole raw cohort. Stable JSON records are retained byte-for-byte under `queue-files`, with explicit absent-directory evidence. Reads are bounded to 2,000 entries per directory, 32 MiB per JSON and 64 MiB total; links and nonregular entries are rejected. Temporary/quarantined files contribute to the inventory but are not executable records. This proves an unchanged disk window, not a shared owner transaction or persistence drain. The queue copies remain inert until schema preparation and effect adapters validate them; attachment bodies and other sidecar stores are still excluded.

Focused checks:

```powershell
node --test tests/runtime/sqlite-cohort-snapshot.test.mjs tests/runtime/sqlite-cohort-capture-process.test.mjs
```

The process tests use small temporary WAL databases and hidden local child processes. A fixture blocks its event loop with `Atomics.wait` while a real read transaction is pinned: checkpoint is busy before termination and available after confirmed process exit. Another fixture blocks at hashing. Additional cases cover cancellation, ordinary worker failure, pre-cancelled work and a reported failure followed by blocked cleanup. No Hub, production snapshot, provider or network process is started.
