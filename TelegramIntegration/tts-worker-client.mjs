import { createInterface } from "node:readline";

function workerFailureMessage({ code, signal, stderr }) {
  const details = String(stderr ?? "").trim();
  return details || `TTS worker stopped (code=${code}, signal=${signal})`;
}

export function runTtsWorkerRequest({
  spawnWorker,
  request,
  timeoutMs,
  terminateWorker = (worker) => worker.kill(),
  onWorkerChange = () => {},
  onDiagnostic = () => {},
}) {
  return new Promise((resolve, reject) => {
    let worker;
    let lines;
    let timer;
    let settled = false;
    let phase = "запуск worker";
    let stderr = "";

    const finish = (error, outputPath, { terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines?.close();
      onWorkerChange(null, worker);
      if (terminate && worker) {
        Promise.resolve(terminateWorker(worker)).catch(() => worker.kill());
      }
      if (error) reject(error);
      else resolve(outputPath);
    };

    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(
          new Error(`нет прогресса озвучивания более ${Math.ceil(timeoutMs / 1000)} сек. (этап: ${phase})`),
          null,
          { terminate: true },
        );
      }, timeoutMs);
    };

    try {
      worker = spawnWorker();
    } catch (error) {
      finish(new Error(`TTS worker failed to start: ${error.message}`, { cause: error }));
      return;
    }
    onWorkerChange(worker, null);
    armTimeout();

    worker.stderr?.setEncoding?.("utf8");
    worker.stderr?.on("data", (data) => {
      const chunk = String(data);
      stderr = `${stderr}${chunk}`.slice(-16_384);
      onDiagnostic(chunk.trimEnd());
    });
    worker.once("error", (error) => {
      finish(new Error(`TTS worker error: ${error.message}`, { cause: error }));
    });
    worker.once("close", (code, signal) => {
      if (!settled) finish(new Error(workerFailureMessage({ code, signal, stderr })));
    });
    worker.stdin.once("error", (error) => {
      finish(new Error(`TTS worker stdin failed: ${error.message}`, { cause: error }), null, { terminate: true });
    });

    lines = createInterface({ input: worker.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        onDiagnostic(`Invalid TTS worker message: ${error.message}`);
        return;
      }
      if (message?.id !== request.id) return;
      if (message.progress === true) {
        phase = String(message.phase ?? "синтез");
        armTimeout();
        return;
      }
      if (message.ok) finish(null, message.outputPath);
      else finish(new Error(message.error || "Неизвестная ошибка TTS"));
    });

    worker.once("spawn", () => {
      phase = "передача запроса";
      armTimeout();
      worker.stdin.end(`${JSON.stringify(request)}\n`, (error) => {
        if (error) finish(error, null, { terminate: true });
      });
    });
  });
}
