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

export class PersistentTtsWorkerClient {
  constructor({
    spawnWorker,
    timeoutMs,
    terminateWorker = (worker) => worker.kill(),
    onWorkerChange = () => {},
    onDiagnostic = () => {},
  }) {
    this.spawnWorker = spawnWorker;
    this.timeoutMs = timeoutMs;
    this.terminateWorker = terminateWorker;
    this.onWorkerChange = onWorkerChange;
    this.onDiagnostic = onDiagnostic;
    this.worker = null;
    this.lines = null;
    this.pending = null;
    this.stderr = "";
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.spawnWorker();
    this.worker = worker;
    this.stderr = "";
    this.onWorkerChange(worker, null);
    worker.stderr?.setEncoding?.("utf8");
    worker.stderr?.on("data", (data) => {
      const chunk = String(data);
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
      this.onDiagnostic(chunk.trimEnd());
    });
    worker.on("error", (error) => this.failWorker(new Error(`TTS worker error: ${error.message}`, { cause: error })));
    worker.on("close", (code, signal) => {
      if (this.worker !== worker) return;
      const details = workerFailureMessage({ code, signal, stderr: this.stderr });
      this.clearWorker(worker);
      this.finishPending(new Error(details));
    });
    worker.stdin.on("error", (error) => {
      this.failWorker(new Error(`TTS worker stdin failed: ${error.message}`, { cause: error }));
    });
    this.lines = createInterface({ input: worker.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    return worker;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.onDiagnostic(`Invalid TTS worker message: ${error.message}`);
      return;
    }
    if (!this.pending || message?.id !== this.pending.request.id) return;
    if (message.progress === true) {
      this.pending.phase = String(message.phase ?? "синтез");
      this.armTimeout();
      return;
    }
    if (message.ok) this.finishPending(null, message.outputPath);
    else this.finishPending(new Error(message.error || "Неизвестная ошибка TTS"));
  }

  armTimeout() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.timer = setTimeout(() => {
      const phase = this.pending?.phase ?? "синтез";
      const error = new Error(
        `нет прогресса озвучивания более ${Math.ceil(this.timeoutMs / 1000)} сек. (этап: ${phase})`,
      );
      this.failWorker(error);
    }, this.timeoutMs);
  }

  finishPending(error, outputPath) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(outputPath);
  }

  clearWorker(worker = this.worker) {
    if (!worker || this.worker !== worker) return;
    this.lines?.close();
    this.lines = null;
    this.worker = null;
    this.onWorkerChange(null, worker);
  }

  failWorker(error) {
    const worker = this.worker;
    this.clearWorker(worker);
    this.finishPending(error);
    if (worker) Promise.resolve(this.terminateWorker(worker)).catch(() => worker.kill());
  }

  request(request) {
    if (this.pending) return Promise.reject(new Error("TTS worker is already processing a request"));
    let worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(new Error(`TTS worker failed to start: ${error.message}`, { cause: error }));
    }
    return new Promise((resolve, reject) => {
      this.pending = { request, resolve, reject, timer: null, phase: "передача запроса" };
      this.armTimeout();
      worker.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) this.failWorker(error);
      });
    });
  }

  close() {
    const worker = this.worker;
    if (!worker) return;
    this.clearWorker(worker);
    this.finishPending(new Error("TTS worker stopped"));
    Promise.resolve(this.terminateWorker(worker)).catch(() => worker.kill());
  }
}
