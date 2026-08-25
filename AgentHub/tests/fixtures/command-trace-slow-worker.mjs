import { parentPort, workerData } from "node:worker_threads";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue.then(async () => {
    if (message.type === "append-best-effort" && workerData.crashOnAppend === true) {
      process.exit(23);
    }
    if (message.type === "append-best-effort") await delay(workerData.delayMs ?? 250);
    parentPort.postMessage({ id: message.id, bestEffort: message.bestEffort === true, value: { ready: true } });
    if (message.type === "close") parentPort.close();
  });
});
