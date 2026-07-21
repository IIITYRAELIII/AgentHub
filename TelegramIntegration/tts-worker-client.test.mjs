import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { runTtsWorkerRequest } from "./tts-worker-client.mjs";

function nodeWorker(source) {
  return () => spawn(process.execPath, ["-e", source], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("one-shot TTS worker receives one request and extends its timeout on progress", async () => {
  const source = String.raw`
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      setTimeout(() => console.log(JSON.stringify({ id: request.id, progress: true, phase: "chunk-1" })), 800);
      setTimeout(() => console.log(JSON.stringify({ id: request.id, ok: true, outputPath: request.outputPath })), 2200);
    });
  `;
  const workers = [];
  const outputPath = await runTtsWorkerRequest({
    spawnWorker: nodeWorker(source),
    request: { id: "request-1", text: "Тест", outputPath: "voice.ogg" },
    timeoutMs: 2000,
    onWorkerChange: (worker) => workers.push(worker),
  });

  assert.equal(outputPath, "voice.ogg");
  assert.ok(workers[0]?.pid);
  assert.equal(workers.at(-1), null);
});

test("one-shot TTS worker reports the stalled phase and is terminated", async () => {
  let terminated = false;
  await assert.rejects(runTtsWorkerRequest({
    spawnWorker: nodeWorker("process.stdin.resume(); setInterval(() => {}, 1000);"),
    request: { id: "request-2", text: "Тест", outputPath: "voice.ogg" },
    timeoutMs: 30,
    terminateWorker: (worker) => {
      terminated = true;
      worker.kill();
    },
  }), /этап: передача запроса/);
  assert.equal(terminated, true);
});

test("one-shot TTS worker returns its structured synthesis error", async () => {
  const source = String.raw`
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      console.log(JSON.stringify({ id: request.id, ok: false, error: "ошибка модели" }));
    });
  `;
  await assert.rejects(runTtsWorkerRequest({
    spawnWorker: nodeWorker(source),
    request: { id: "request-3", text: "Тест", outputPath: "voice.ogg" },
    timeoutMs: 1000,
  }), /ошибка модели/);
});
