import { spawn } from "node:child_process";
import process from "node:process";

import { processIsAlive } from "./process-liveness.mjs";

export async function stopProcessTree(pid, {
  platform = process.platform,
  spawnImpl = spawn,
  killImpl = process.kill,
  processGroup = true,
  timeoutMs = 5_000,
} = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (platform !== "win32") {
    try {
      killImpl(processGroup ? -value : value, "SIGTERM");
      return true;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    let killer;
    const finish = (valueToReturn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(valueToReturn);
    };
    const timer = setTimeout(() => {
      killer?.kill?.();
      finish(false);
    }, Math.max(1, Number(timeoutMs) || 5_000));
    timer.unref?.();
    const fallback = () => {
      try {
        killImpl(value, "SIGTERM");
        finish(true);
      } catch (error) {
        finish(error?.code === "ESRCH");
      }
    };
    try {
      killer = spawnImpl("taskkill.exe", ["/PID", String(value), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      fallback();
      return;
    }
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code === 0 || !processIsAlive(value, killImpl)) finish(true);
      else fallback();
    });
  });
}
