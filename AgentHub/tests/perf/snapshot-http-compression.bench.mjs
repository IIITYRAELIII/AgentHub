import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";

import { createJsonResponder } from "../../src/interfaces/web/mini-app-server.mjs";

const SNAPSHOT_COUNT = 18;
const SNAPSHOT_CONCURRENCY = 3;
const COMMAND_COUNT = 40;
const COMMAND_INTERVAL_MS = 15;

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return Math.round(ordered[Math.ceil(ordered.length * fraction) - 1] ?? 0);
}

if (!isMainThread) {
  const { request } = await import("node:http");
  const agent = new (await import("node:http")).Agent({ keepAlive: true, maxSockets: 64 });
  function get(path) {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const req = request(`${workerData.url}${path}`, {
        agent,
        headers: { "Accept-Encoding": "gzip" },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve({
          status: response.statusCode,
          durationMs: performance.now() - started,
        }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  const commandRequests = [];
  const snapshotDurations = [];
  const timer = setInterval(() => {
    commandRequests.push(get("/command"));
    if (commandRequests.length === COMMAND_COUNT) clearInterval(timer);
  }, COMMAND_INTERVAL_MS);
  let nextSnapshot = 0;
  async function snapshotWorker() {
    while (nextSnapshot < SNAPSHOT_COUNT) {
      nextSnapshot += 1;
      const result = await get("/snapshot");
      if (result.status !== 200) throw new Error(`snapshot HTTP ${result.status}`);
      snapshotDurations.push(result.durationMs);
    }
  }
  await Promise.all(Array.from({ length: SNAPSHOT_CONCURRENCY }, snapshotWorker));
  while (commandRequests.length < COMMAND_COUNT) await new Promise((resolve) => setTimeout(resolve, 10));
  const commands = await Promise.all(commandRequests);
  agent.destroy();
  if (commands.some((item) => item.status !== 200)) throw new Error("command HTTP failure");
  const durations = commands.map((item) => item.durationMs);
  parentPort.postMessage({
    commandCount: commands.length,
    snapshotCount: SNAPSHOT_COUNT,
    commandP50Ms: percentile(durations, 0.5),
    commandP95Ms: percentile(durations, 0.95),
    commandMaxMs: Math.round(Math.max(...durations)),
    snapshotP50Ms: percentile(snapshotDurations, 0.5),
    snapshotP95Ms: percentile(snapshotDurations, 0.95),
    snapshotMaxMs: Math.round(Math.max(...snapshotDurations)),
  });
} else {
  // Same JSON body, client cadence and snapshot concurrency for both modes.
  // The baseline copies the former synchronous response boundary; the candidate
  // uses the production responder. The client has its own event loop so a Hub
  // stall cannot hide time before a command is actually admitted.
  const payload = { text: randomBytes(3 * 1_024 * 1_024).toString("base64") };
  const baseline = (response, value) => {
    const body = gzipSync(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Length": String(body.length),
    });
    response.end(body);
  };
  const candidate = createJsonResponder();
  for (const [mode, sendSnapshot] of [["sync-baseline", baseline], ["async-candidate", (response, value) => {
    candidate(response, 200, value, "GET", { acceptEncoding: "gzip" });
  }]]) {
    const server = createServer((request, response) => {
      if (request.url === "/snapshot") return sendSnapshot(response, payload);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"accepted":true}\n');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { url } });
        let received = false;
        worker.once("message", (value) => {
          received = true;
          resolve(value);
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (!received) reject(new Error(`client worker exited ${code} before reporting`));
        });
      });
      process.stdout.write(`${JSON.stringify({
        mode,
        bodyBytes: Buffer.byteLength(JSON.stringify(payload)),
        snapshotConcurrency: SNAPSHOT_CONCURRENCY,
        ...result,
        eventLoopDelayP95Ms: Math.round(delay.percentile(95) / 1e6),
        eventLoopDelayMaxMs: Math.round(delay.max / 1e6),
      })}\n`);
    } finally {
      delay.disable();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
