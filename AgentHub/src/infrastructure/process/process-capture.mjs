import { spawn } from "node:child_process";

function appendBoundedUtf8(current, chunk, maxOutputBytes) {
  if (Buffer.byteLength(current, "utf8") >= maxOutputBytes) {
    return { value: current, truncated: true };
  }
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxOutputBytes) {
    return { value: combined, truncated: false };
  }
  return {
    value: Buffer.from(combined, "utf8").subarray(0, maxOutputBytes).toString("utf8"),
    truncated: true,
  };
}

export function captureProcess(command, args, {
  timeoutMs = 20_000,
  maxOutputBytes = 1024 * 1024,
  stopProcess = async (worker) => worker.kill(),
  ...spawnOptions
} = {}) {
  return new Promise((resolve) => {
    const worker = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timeoutError = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, stdoutTruncated, stderrTruncated });
    };
    const timer = setTimeout(() => {
      timeoutError = new Error(`process timed out after ${timeoutMs} ms: ${command}`);
      timeoutError.code = "ETIMEDOUT";
      Promise.resolve(stopProcess(worker))
        .catch(() => worker.kill())
        .finally(() => finish({ code: null, error: timeoutError }));
    }, timeoutMs);
    worker.stdout?.setEncoding("utf8");
    worker.stderr?.setEncoding("utf8");
    worker.stdout?.on("data", (chunk) => {
      const appended = appendBoundedUtf8(stdout, chunk, maxOutputBytes);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    worker.stderr?.on("data", (chunk) => {
      const appended = appendBoundedUtf8(stderr, chunk, maxOutputBytes);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    worker.on("error", (error) => finish({ code: null, error }));
    worker.on("close", (code) => {
      if (!timeoutError) finish({ code });
    });
  });
}

