import { spawn } from "node:child_process";

const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/iu;

export function findQuickTunnelUrl(output) {
  return String(output ?? "").match(QUICK_TUNNEL_URL_PATTERN)?.[0] ?? null;
}

export class QuickTunnelController {
  #child = null;
  #executable;
  #localUrl;
  #onUrl;
  #spawn;
  #startPromise = null;
  #timeoutMs;
  #url = null;

  constructor({
    executable = "cloudflared",
    localUrl,
    onUrl,
    spawnImpl = spawn,
    timeoutMs = 30_000,
  } = {}) {
    this.#executable = executable;
    this.#localUrl = String(localUrl);
    this.#onUrl = onUrl;
    this.#spawn = spawnImpl;
    this.#timeoutMs = timeoutMs;
  }

  async start() {
    if (this.#url && this.#child) return this.#url;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = new Promise((resolve, reject) => {
      const child = this.#spawn(
        this.#executable,
        ["tunnel", "--no-autoupdate", "--url", this.#localUrl],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      this.#child = child;
      let output = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Quick Tunnel did not publish an HTTPS URL in time"));
      }, this.#timeoutMs);
      timeout.unref?.();
      const consume = (chunk) => {
        output = `${output}${String(chunk)}`.slice(-16_384);
        const url = findQuickTunnelUrl(output);
        if (!url || settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#url = url;
        Promise.resolve(this.#onUrl?.(url)).then(() => resolve(url), reject);
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        this.#child = null;
        this.#url = null;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Quick Tunnel exited before startup (${signal ?? code ?? "unknown"})`));
      });
    }).finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async close() {
    const child = this.#child;
    this.#child = null;
    this.#url = null;
    if (!child || child.exitCode != null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}
