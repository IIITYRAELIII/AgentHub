import { serveCaptureWorker } from "../../src/runtime/sqlite-cohort-capture-worker.mjs";
import { captureSqliteCohort } from "../../src/runtime/sqlite-cohort-snapshot.mjs";

serveCaptureWorker((options) => captureSqliteCohort({ ...options,
  onProgress: async (progress) => {
    await options.onProgress(progress);
    // Fixture selection lives in the explicitly named synthetic source root,
    // never in production prompt/data or the worker's public capture options.
    const blockHash = options.sourceDataDirectory.endsWith("source-block-hash");
    if (progress.phase === (blockHash ? "hashing" : "copying")) {
      if (options.sourceDataDirectory.endsWith("source-reported-failure")) {
        await new Promise((resolve, reject) => process.send({ type: "failure", error: { message: "fixture reported failure before blocked cleanup" } }, (error) => error ? reject(error) : resolve()));
      }
      // A blocked worker event loop cannot service its own timeout or IPC.
      // Only the supervisor's process termination can release this read pin.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
}));
