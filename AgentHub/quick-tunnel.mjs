import { spawn } from "node:child_process";

const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/iu;
const PINGGY_URL_PATTERN = /^https:\/\/[a-z0-9.-]+\.(?:free\.pinggy\.net|run\.pinggy-free\.link)\/?$/iu;

export function findQuickTunnelUrl(output) {
  return String(output ?? "").match(QUICK_TUNNEL_URL_PATTERN)?.[0] ?? null;
}

export class QuickTunnelController {
  #child = null;
  #controlPort;
  #executable;
  #localUrl;
  #mode;
  #onUrl;
  #provider;
  #publicUrl;
  #fetch;
  #spawn;
  #startPromise = null;
  #timeoutMs;
  #tokenFile;
  #url = null;

  constructor({
    executable = "cloudflared",
    localUrl,
    onUrl,
    provider = "cloudflare",
    mode = "quick",
    publicUrl = null,
    tokenFile = null,
    controlPort = 4300,
    spawnImpl = spawn,
    fetchImpl = fetch,
    timeoutMs = 30_000,
  } = {}) {
    this.#executable = executable;
    this.#localUrl = String(localUrl);
    this.#onUrl = onUrl;
    this.#provider = provider;
    this.#mode = mode;
    this.#publicUrl = publicUrl;
    this.#tokenFile = tokenFile;
    this.#controlPort = controlPort;
    this.#spawn = spawnImpl;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async #waitUntilReachable(url) {
    const deadline = Date.now() + this.#timeoutMs;
    let lastStatus = "unavailable";
    while (Date.now() < deadline) {
      try {
        const response = await this.#fetch(`${url}/health`, { cache: "no-store" });
        lastStatus = `HTTP ${response.status}`;
        if (response.ok) return;
      } catch (error) {
        lastStatus = error.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Tunnel health check failed: ${lastStatus}`);
  }

  async #waitForPinggyUrl() {
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await this.#fetch(`http://127.0.0.1:${this.#controlPort}/urls`, {
          cache: "no-store",
        });
        if (response.ok) {
          const payload = await response.json();
          const url = payload.urls?.find((item) => PINGGY_URL_PATTERN.test(String(item)));
          if (url) return String(url).replace(/\/$/u, "");
        }
      } catch {
        // The local debugger API appears only after SSH forwarding is ready.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Pinggy did not publish an HTTPS URL in time");
  }

  #spawnArguments() {
    if (this.#mode === "named") {
      return [
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "run",
        "--token-file",
        this.#tokenFile,
      ];
    }
    if (this.#provider === "pinggy") {
      const origin = new URL(this.#localUrl);
      return [
        "-p",
        "443",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-T",
        `-R0:${origin.hostname}:${origin.port}`,
        `-L${this.#controlPort}:127.0.0.1:${this.#controlPort}`,
        "free.pinggy.io",
      ];
    }
    return ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", this.#localUrl];
  }

  async start() {
    if (this.#url && this.#child) return this.#url;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = new Promise((resolve, reject) => {
      const child = this.#spawn(
        this.#executable,
        this.#spawnArguments(),
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      this.#child = child;
      let output = "";
      let settled = false;
      let publishing = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Quick Tunnel did not publish an HTTPS URL in time"));
      }, this.#timeoutMs);
      timeout.unref?.();
      const consume = (chunk) => {
        output = `${output}${String(chunk)}`.slice(-16_384);
        if (this.#mode === "named" && !settled && !publishing) {
          publishing = true;
          clearTimeout(timeout);
          this.#waitUntilReachable(this.#publicUrl)
            .then(() => this.#onUrl?.(this.#publicUrl))
            .then(() => {
              settled = true;
              this.#url = this.#publicUrl;
              resolve(this.#publicUrl);
            }, (error) => {
              settled = true;
              reject(error);
            });
          return;
        }
        const url = findQuickTunnelUrl(output);
        if (!url || settled || publishing) return;
        publishing = true;
        clearTimeout(timeout);
        this.#waitUntilReachable(url)
          .then(() => this.#onUrl?.(url))
          .then(() => {
            settled = true;
            this.#url = url;
            resolve(url);
          }, (error) => {
            settled = true;
            reject(error);
          });
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      if (this.#provider === "pinggy" && this.#mode === "quick") {
        this.#waitForPinggyUrl().then((url) => {
          if (!settled && !publishing) {
            output += ` ${url}`;
            publishing = true;
            clearTimeout(timeout);
            this.#waitUntilReachable(url)
              .then(() => this.#onUrl?.(url))
              .then(() => {
                settled = true;
                this.#url = url;
                resolve(url);
              }, (error) => {
                settled = true;
                reject(error);
              });
          }
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        });
      }
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
