import { spawn } from "node:child_process";
import process from "node:process";

import { processIsAlive } from "./process-liveness.mjs";

export async function stopProcessTree(pid, {
  platform = process.platform,
  spawnImpl = spawn,
  killImpl = process.kill,
} = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (platform !== "win32") {
    try {
      killImpl(-value, "SIGTERM");
      return true;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (valueToReturn) => {
      if (settled) return;
      settled = true;
      resolve(valueToReturn);
    };
    const fallback = () => {
      try {
        killImpl(value, "SIGTERM");
        finish(true);
      } catch (error) {
        finish(error?.code === "ESRCH");
      }
    };
    let killer;
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
