import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

function windowsCustodyCommand(rootPid) {
  const source = fileURLToPath(new URL("./codex-app-server-job-custody.cs", import.meta.url));
  const literal = `'${source.replaceAll("'", "''")}'`;
  return [
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$ProgressPreference='SilentlyContinue'",
    "$ErrorActionPreference='Stop'",
    `Add-Type -Path ${literal}`,
    `[CodexAppServerJobCustody]::Run(${rootPid})`,
  ].join(";");
}

export function createCodexAppServerJobCustody(rootPid, {
  platform = process.platform,
  spawnImpl = spawn,
  startupTimeoutMs = 10_000,
} = {}) {
  const pid = Number(rootPid);
  if (platform !== "win32") return null;
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError("Codex App Server root PID is required");

  const command = windowsCustodyCommand(pid);
  const helper = spawnImpl("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-OutputFormat", "Text",
    "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64"),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: helper.stdout });
  const diagnostics = { rootPid: pid, helperPid: helper.pid ?? null, state: "starting", active: null, error: null };
  let stderr = "";
  let pending = null;
  let failure = null;
  let closeFlight = null;
  const values = [];

  const fail = (error) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    diagnostics.state = "failed";
    diagnostics.error = String(failure.code ?? failure.message).slice(0, 160);
    pending?.reject(failure);
    pending = null;
  };
  helper.stderr?.setEncoding("utf8");
  helper.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_096); });
  helper.on("error", fail);
  helper.stdin.on("error", fail);
  lines.on("line", (line) => {
    let value;
    try { value = JSON.parse(line); }
    catch (error) { fail(error); return; }
    diagnostics.state = value.state;
    diagnostics.active = Number(value.active);
    if (pending) {
      const receiver = pending;
      pending = null;
      receiver.resolve(value);
    } else values.push(value);
  });
  const exited = once(helper, "close").then(([code]) => {
    if (code !== 0) fail(Object.assign(
      new Error(`Codex App Server job custody exited ${code}: ${stderr}`),
      { code: "CODEX_APP_SERVER_CUSTODY_EXITED" },
    ));
    else if (pending) fail(Object.assign(
      new Error("Codex App Server job custody closed before confirmation"),
      { code: "CODEX_APP_SERVER_CUSTODY_UNCONFIRMED" },
    ));
  });

  const receive = (timeoutMs = startupTimeoutMs) => {
    if (failure) return Promise.reject(failure);
    if (values.length) return Promise.resolve(values.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.reject === reject) pending = null;
        reject(Object.assign(new Error("Codex App Server job custody timed out"), {
          code: "CODEX_APP_SERVER_CUSTODY_TIMEOUT",
        }));
      }, Math.max(1, Number(timeoutMs) || startupTimeoutMs));
      timer.unref?.();
      pending = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  };

  return {
    diagnostics: () => ({ ...diagnostics }),
    async start() {
      const ready = await receive();
      if (ready?.state !== "ready" || ready.rootPid !== pid || Number(ready.active) < 1) {
        throw Object.assign(new Error("Codex App Server job custody did not bind the exact root"), {
          code: "CODEX_APP_SERVER_CUSTODY_UNCONFIRMED",
        });
      }
      return true;
    },
    close() {
      if (closeFlight) return closeFlight;
      closeFlight = (async () => {
        if (failure) throw failure;
        helper.stdin.end("close\n");
        const closed = await receive(7_000);
        await exited;
        if (failure) throw failure;
        if (closed?.state !== "closed" || closed.rootPid !== pid || Number(closed.active) !== 0) {
          throw Object.assign(new Error("Codex App Server job custody did not confirm empty cohort"), {
            code: "CODEX_APP_SERVER_CUSTODY_UNCONFIRMED",
          });
        }
        diagnostics.state = "closed";
        return true;
      })().finally(() => lines.close());
      return closeFlight;
    },
  };
}
