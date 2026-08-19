import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import path from "node:path";

const STARTUP_GRACE_MS = 1_500;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const RECOVERY_DELAY_MS = 1_000;
const MAX_ADDITIONAL_ROUTES = 8;

function httpsOrigin(value, label) {
  const normalized = String(value ?? "").trim().replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTPS origin without credentials or path`);
  }
  return { url: normalized, domain: parsed.hostname };
}

function privateNetworkHost(hostname) {
  const normalized = String(hostname ?? "").replace(/^\[|\]$/gu, "").toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (family === 6) return normalized === "::1" || /^f[cd]/u.test(normalized) || /^fe[89ab]/u.test(normalized);
  return normalized === "localhost";
}

function additionalRoute(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Direct gateway route ${index + 1} must be an object`);
  }
  const publicOrigin = httpsOrigin(raw.publicUrl, `Direct gateway route ${index + 1} publicUrl`);
  let upstream;
  try {
    upstream = new URL(String(raw.upstreamUrl ?? "").trim());
  } catch {
    throw new Error(`Direct gateway route ${index + 1} upstreamUrl must be an absolute origin`);
  }
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.pathname !== "/" || upstream.search || upstream.hash || !privateNetworkHost(upstream.hostname)) {
    throw new Error(`Direct gateway route ${index + 1} upstreamUrl must be a private HTTP(S) origin`);
  }
  return {
    publicUrl: publicOrigin.url,
    domain: publicOrigin.domain,
    upstreamUrl: upstream.origin,
  };
}

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
  const publicOrigin = httpsOrigin(raw.publicUrl, "Direct gateway publicUrl");
  const rawRoutes = raw.routes ?? [];
  if (!Array.isArray(rawRoutes) || rawRoutes.length > MAX_ADDITIONAL_ROUTES) {
    throw new Error(`Direct gateway routes must be an array of at most ${MAX_ADDITIONAL_ROUTES} items`);
  }
  const routes = rawRoutes.map(additionalRoute);
  const domains = new Set([publicOrigin.domain]);
  for (const route of routes) {
    if (domains.has(route.domain)) throw new Error(`Duplicate direct gateway domain: ${route.domain}`);
    domains.add(route.domain);
  }
  const executable = path.resolve(path.dirname(filePath), String(raw.executable ?? "gateway/caddy.exe"));
  await access(executable);
  const resolvedLocalUrl = new URL(String(localUrl));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(resolvedLocalUrl.hostname)) {
    throw new Error("Direct gateway backend must use a loopback address");
  }
  return {
    enabled: true,
    publicUrl: publicOrigin.url,
    domain: publicOrigin.domain,
    executable,
    localUrl: resolvedLocalUrl.origin,
    routes,
    workingDirectory: path.join(path.dirname(filePath), "gateway"),
  };
}

function caddySite(domain, upstreamUrl) {
  const backend = new URL(upstreamUrl);
  return `${domain} {
  encode zstd gzip
  reverse_proxy ${backend.host} {
    header_up X-Forwarded-For {remote_host}
    header_up -CF-Connecting-IP
  }
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }
}`;
}

export function directGatewayCaddyfile({ domain, localUrl, routes = [] }) {
  const sites = [caddySite(domain, localUrl), ...routes.map((route) => (
    caddySite(route.domain, route.upstreamUrl)
  ))];
  return `{
  admin off
  servers {
    protocols h1 h2
  }
}

${sites.join("\n\n")}
`;
}

function probeExistingDirectGateway({ domain }) {
  return new Promise((resolve) => {
    const probe = request({
      hostname: "127.0.0.1",
      port: 443,
      servername: domain,
      path: "/health",
      method: "GET",
      headers: { Accept: "application/json", Host: domain },
      agent: false,
      timeout: STARTUP_GRACE_MS,
    }, (response) => {
      response.resume();
      resolve(/\bcaddy\b/iu.test(String(response.headers.via ?? "")));
    });
    probe.once("timeout", () => probe.destroy());
    probe.once("error", () => resolve(false));
    probe.end();
  });
}

export class DirectGatewayController {
  #child = null;
  #closing = false;
  #healthTimer = null;
  #probe;
  #settings;
  #spawn;
  #startup = null;

  constructor(settings, {
    spawnImpl = spawn,
    probeImpl = probeExistingDirectGateway,
    logger = console,
    healthCheckIntervalMs = HEALTH_CHECK_INTERVAL_MS,
    recoveryDelayMs = RECOVERY_DELAY_MS,
    startupGraceMs = STARTUP_GRACE_MS,
    scheduleHealthCheckImpl = setTimeout,
    cancelHealthCheckImpl = clearTimeout,
  } = {}) {
    this.#settings = settings;
    this.#spawn = spawnImpl;
    this.#probe = probeImpl;
    this.logger = logger;
    this.healthCheckIntervalMs = Math.max(1, Number(healthCheckIntervalMs) || HEALTH_CHECK_INTERVAL_MS);
    this.recoveryDelayMs = Math.max(1, Number(recoveryDelayMs) || RECOVERY_DELAY_MS);
    this.startupGraceMs = Math.max(0, Number(startupGraceMs) || 0);
    this.scheduleHealthCheck = scheduleHealthCheckImpl;
    this.cancelHealthCheck = cancelHealthCheckImpl;
  }

  async start() {
    this.#closing = false;
    if (this.#child && this.#child.exitCode == null) {
      this.#ensureHealthCheck();
      return this.#settings.publicUrl;
    }
    const { workingDirectory } = this.#settings;
    await mkdir(workingDirectory, { recursive: true });
    const caddyfile = path.join(workingDirectory, "Caddyfile");
    const desiredConfig = directGatewayCaddyfile(this.#settings);
    const existingConfig = await readFile(caddyfile, "utf8").catch(() => "");
    if (existingConfig === desiredConfig && await this.#probe(this.#settings)) {
      this.#ensureHealthCheck();
      return this.#settings.publicUrl;
    }
    try {
      await this.#launch();
    } finally {
      this.#ensureHealthCheck(this.recoveryDelayMs);
    }
    return this.#settings.publicUrl;
  }

  async #launch() {
    if (this.#startup) return this.#startup;
    this.#startup = this.#launchOnce();
    try {
      await this.#startup;
    } finally {
      this.#startup = null;
    }
  }

  async #launchOnce() {
    const { executable, workingDirectory } = this.#settings;
    const caddyfile = path.join(workingDirectory, "Caddyfile");
    const desiredConfig = directGatewayCaddyfile(this.#settings);
    await writeFile(caddyfile, desiredConfig, "utf8");
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
      }, this.startupGraceMs);
      timer.unref?.();
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (this.#child === child) this.#child = null;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Caddy exited during startup (${signal ?? code ?? "unknown"}): ${output.trim()}`));
      });
    });
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = null;
      if (this.#closing) return;
      this.logger.warn(`Direct gateway exited (${signal ?? code ?? "unknown"}); scheduling recovery`);
      this.#ensureHealthCheck(this.recoveryDelayMs, { replace: true });
    });
  }

  #ensureHealthCheck(delayMs = this.healthCheckIntervalMs, { replace = false } = {}) {
    if (this.#closing) return;
    if (this.#healthTimer) {
      if (!replace) return;
      this.cancelHealthCheck(this.#healthTimer);
      this.#healthTimer = null;
    }
    this.#healthTimer = this.scheduleHealthCheck(async () => {
      this.#healthTimer = null;
      if (this.#closing) return;
      try {
        const healthy = await this.#probe(this.#settings);
        if (!healthy && (!this.#child || this.#child.exitCode != null)) {
          this.logger.warn("Direct gateway health check failed; restarting Caddy");
          await this.#launch();
          this.logger.log(`Direct Agent Hub gateway recovered at ${this.#settings.publicUrl}`);
        }
      } catch (error) {
        this.logger.error(`Cannot recover direct gateway: ${error.message}`);
      } finally {
        this.#ensureHealthCheck();
      }
    }, delayMs);
    this.#healthTimer?.unref?.();
  }

  async close() {
    this.#closing = true;
    if (this.#healthTimer) {
      this.cancelHealthCheck(this.#healthTimer);
      this.#healthTimer = null;
    }
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
