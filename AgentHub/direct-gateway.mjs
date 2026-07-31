import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STARTUP_GRACE_MS = 1_500;

export async function loadDirectGatewaySettings(filePath, { localUrl } = {}) {
  let raw;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { enabled: false };
    throw new Error(`Cannot read direct gateway settings: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Direct gateway settings must be an object");
  }
  if (raw.enabled === false) return { enabled: false };
  const publicUrl = String(raw.publicUrl ?? "").trim().replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error("Direct gateway publicUrl must be an absolute HTTPS origin");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Direct gateway publicUrl must be an HTTPS origin without credentials or path");
  }
  const executable = path.resolve(path.dirname(filePath), String(raw.executable ?? "gateway/caddy.exe"));
  await access(executable);
  const resolvedLocalUrl = new URL(String(localUrl));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(resolvedLocalUrl.hostname)) {
    throw new Error("Direct gateway backend must use a loopback address");
  }
  return {
    enabled: true,
    publicUrl,
    domain: parsed.hostname,
    executable,
    localUrl: resolvedLocalUrl.origin,
    workingDirectory: path.join(path.dirname(filePath), "gateway"),
  };
}

export function directGatewayCaddyfile({ domain, localUrl }) {
  const backend = new URL(localUrl);
  return `{
  admin off
}

${domain} {
  encode zstd gzip
  reverse_proxy ${backend.hostname}:${backend.port}
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Frame-Options "SAMEORIGIN"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }
}
`;
}

export class DirectGatewayController {
  #child = null;
  #settings;
  #spawn;

  constructor(settings, { spawnImpl = spawn } = {}) {
    this.#settings = settings;
    this.#spawn = spawnImpl;
  }

  async start() {
    if (this.#child && this.#child.exitCode == null) return this.#settings.publicUrl;
    const { executable, workingDirectory } = this.#settings;
    await mkdir(workingDirectory, { recursive: true });
    const caddyfile = path.join(workingDirectory, "Caddyfile");
    await writeFile(caddyfile, directGatewayCaddyfile(this.#settings), "utf8");
    const child = this.#spawn(executable, ["run", "--config", caddyfile, "--adapter", "caddyfile"], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(workingDirectory, "data"),
        XDG_CONFIG_HOME: path.join(workingDirectory, "config"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    let output = "";
    const consume = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-16_384);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve();
      }, STARTUP_GRACE_MS);
      timer.unref?.();
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        this.#child = null;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Caddy exited during startup (${signal ?? code ?? "unknown"}): ${output.trim()}`));
      });
    });
    return this.#settings.publicUrl;
  }

  async close() {
    const child = this.#child;
    this.#child = null;
    if (!child || child.exitCode != null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}
