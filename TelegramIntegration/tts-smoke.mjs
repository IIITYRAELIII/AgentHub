import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { stopProcessTree } from "./claude-run-io.mjs";
import { INTEGRATION_ROOT, loadConfig } from "./config.mjs";
import { runTtsWorkerRequest } from "./tts-worker-client.mjs";

const config = await loadConfig();
const text = process.argv.slice(2).join(" ").trim()
  || "Проверка локальной озвучки Telegram. Синтез речи работает.";
const outputPath = path.join(config.ttsDir, `smoke-${randomUUID()}.ogg`);
await mkdir(config.ttsDir, { recursive: true });

const startedAt = Date.now();
try {
  const result = await runTtsWorkerRequest({
    spawnWorker: () => spawn(config.ttsPythonExe, [
      config.ttsWorkerScript,
      "--idle-timeout", String(config.ttsIdleTimeoutSeconds),
      "--model", config.ttsModel,
      "--speaker", config.ttsSpeaker,
      "--cache-dir", config.ttsCacheDir,
      "--max-chars", String(config.ttsMaxChars),
    ], {
      cwd: INTEGRATION_ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", TORCH_HOME: config.ttsCacheDir },
    }),
    request: { id: randomUUID(), text, outputPath },
    timeoutMs: config.ttsRequestTimeoutSeconds * 1000,
    terminateWorker: (worker) => stopProcessTree(worker.pid).catch(() => worker.kill()),
    onDiagnostic: (message) => {
      if (message) console.error(`[tts] ${message}`);
    },
  });
  const info = await stat(result);
  if (!info.isFile() || info.size === 0) throw new Error("TTS created an empty output file");
  console.log(JSON.stringify({
    ok: true,
    bytes: info.size,
    elapsedMs: Date.now() - startedAt,
  }));
} finally {
  await unlink(outputPath).catch(() => {});
}
