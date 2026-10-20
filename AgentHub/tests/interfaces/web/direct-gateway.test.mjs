import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DirectGatewayController,
  directGatewayCaddyfile,
  loadDirectGatewaySettings,
} from "../../../src/interfaces/web/direct-gateway.mjs";

test("actual pinned Caddy bounds only the Hub upstream pool below Node's five second keepalive", {
  skip: !process.env.AGENT_HUB_TEST_CADDY ? "Set AGENT_HUB_TEST_CADDY and its verified SHA256 for optional gateway QA" : false,
}, async t => {
  const executable = process.env.AGENT_HUB_TEST_CADDY, expected = process.env.AGENT_HUB_TEST_CADDY_SHA256;
  assert.ok(path.isAbsolute(executable) && /^[a-f0-9]{64}$/u.test(expected ?? ""));
  assert.equal(createHash("sha256").update(await readFile(executable)).digest("hex"), expected);
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-caddy-adapt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "Caddyfile");
  await writeFile(file, directGatewayCaddyfile({ domain: "hub.example.invalid", localUrl: "http://127.0.0.1:8787",
    routes: [{ domain: "other.example.invalid", upstreamUrl: "http://127.0.0.2:9999" }] }));
  const environment = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "PATHEXT"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(environment, { TEMP: root, TMP: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root });
  const { stdout } = await promisify(execFile)(executable, ["adapt", "--config", file, "--adapter", "caddyfile"],
    { windowsHide: true, cwd: root, env: environment, timeout: 10_000, maxBuffer: 1024 * 1024 });
  const handlers = [];
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (value.handler === "reverse_proxy") handlers.push(value);
    for (const child of Object.values(value)) walk(child);
  }
  walk(JSON.parse(stdout));
  const hub = handlers.find(h => h.upstreams.some(u => u.dial === "127.0.0.1:8787"));
  const other = handlers.find(h => h.upstreams.some(u => u.dial === "127.0.0.2:9999"));
  assert.equal(hub.transport.keep_alive.idle_timeout, 2_000_000_000);
  assert.equal(other.transport?.keep_alive?.idle_timeout, undefined);
});

test("direct gateway settings keep the Hub backend on loopback", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-gateway-"));
  const executable = path.join(directory, "gateway", "caddy.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "test", { flag: "wx" });
  await chmod(executable, 0o700).catch(() => {});
  const filePath = path.join(directory, "gateway.json");
  await writeFile(filePath, JSON.stringify({
    enabled: true,
    publicUrl: "https://hub.example.test",
    executable: "gateway/caddy.exe",
  }));
  const settings = await loadDirectGatewaySettings(filePath, {
    localUrl: "http://127.0.0.1:8787/",
  });
  assert.equal(settings.domain, "hub.example.test");
  assert.equal(settings.localUrl, "http://127.0.0.1:8787");
  assert.match(directGatewayCaddyfile(settings), /reverse_proxy 127\.0\.0\.1:8787/u);
  assert.match(directGatewayCaddyfile(settings), /header_up X-Forwarded-For \{remote_host\}/u);
  assert.match(directGatewayCaddyfile(settings), /header_up -CF-Connecting-IP/u);
  assert.match(directGatewayCaddyfile(settings), /X-Frame-Options "DENY"/u);
  await assert.rejects(
    () => loadDirectGatewaySettings(filePath, { localUrl: "http://192.0.2.10:8787" }),
    /loopback/u,
  );
});

test("missing direct gateway settings disable the route", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-gateway-missing-"));
  assert.deepEqual(await loadDirectGatewaySettings(path.join(directory, "missing.json"), {
    localUrl: "http://127.0.0.1:8787",
  }), { enabled: false });
});

test("direct gateway routes additional private-network Hub instances by hostname", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-gateway-routes-"));
  const executable = path.join(directory, "gateway", "caddy.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "test", { flag: "wx" });
  await chmod(executable, 0o700).catch(() => {});
  const filePath = path.join(directory, "gateway.json");
  await writeFile(filePath, JSON.stringify({
    enabled: true,
    publicUrl: "https://home.example.test",
    executable: "gateway/caddy.exe",
    routes: [{
      publicUrl: "https://katya.example.test",
      upstreamUrl: "http://192.168.3.23:8787",
    }],
  }));

  const settings = await loadDirectGatewaySettings(filePath, {
    localUrl: "http://127.0.0.1:8787",
  });
  assert.deepEqual(settings.routes, [{
    publicUrl: "https://katya.example.test",
    domain: "katya.example.test",
    upstreamUrl: "http://192.168.3.23:8787",
  }]);
  const caddyfile = directGatewayCaddyfile(settings);
  assert.match(caddyfile, /protocols h1 h2/u);
  assert.match(caddyfile, /home\.example\.test[\s\S]*reverse_proxy 127\.0\.0\.1:8787/u);
  assert.match(caddyfile, /katya\.example\.test[\s\S]*reverse_proxy 192\.168\.3\.23:8787/u);
});

test("direct gateway rejects duplicate domains and public additional upstreams", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-gateway-invalid-route-"));
  const executable = path.join(directory, "gateway", "caddy.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "test", { flag: "wx" });
  await chmod(executable, 0o700).catch(() => {});
  const filePath = path.join(directory, "gateway.json");
  const load = () => loadDirectGatewaySettings(filePath, { localUrl: "http://127.0.0.1:8787" });

  await writeFile(filePath, JSON.stringify({
    publicUrl: "https://home.example.test",
    routes: [{ publicUrl: "https://katya.example.test", upstreamUrl: "http://203.0.113.10:8787" }],
  }));
  await assert.rejects(load, /private HTTP\(S\) origin/u);

  await writeFile(filePath, JSON.stringify({
    publicUrl: "https://home.example.test",
    routes: [{ publicUrl: "https://home.example.test", upstreamUrl: "http://192.168.3.23:8787" }],
  }));
  await assert.rejects(load, /Duplicate direct gateway domain/u);
});

test("replacement runtime adopts an unchanged live direct gateway", async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-gateway-adopt-"));
  const settings = {
    publicUrl: "https://home.example.test",
    domain: "home.example.test",
    executable: path.join(workingDirectory, "caddy.exe"),
    localUrl: "http://127.0.0.1:8787",
    routes: [],
    workingDirectory,
  };
  await writeFile(path.join(workingDirectory, "Caddyfile"), directGatewayCaddyfile(settings));
  let probes = 0;
  const controller = new DirectGatewayController(settings, {
    probeImpl: async () => { probes += 1; return true; },
    spawnImpl: () => { throw new Error("replacement must not spawn a second gateway"); },
  });

  assert.equal(await controller.start(), settings.publicUrl);
  assert.equal(probes, 1);
});

test("changed pre-existing gateway config refuses before write or a competing listener", async t => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "hub-gateway-config-handoff-"));
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));
  const settings = { domain: "hub.example.invalid", publicUrl: "https://hub.example.invalid", localUrl: "http://127.0.0.1:8787",
    workingDirectory, executable: path.join(workingDirectory, "not-executed.exe") };
  const file = path.join(workingDirectory, "Caddyfile"), previous = "retained old gateway configuration\n";
  await writeFile(file, previous);
  let spawns = 0;
  const controller = new DirectGatewayController(settings, { spawnImpl: () => { spawns++; assert.fail("no competing gateway"); },
    probeImpl: async () => true, scheduleHealthCheckImpl: () => ({ unref() {} }), cancelHealthCheckImpl: () => {} });
  await assert.rejects(controller.start(), error => error.code === "DIRECT_GATEWAY_CONFIG_HANDOFF_REQUIRED");
  assert.equal(await readFile(file, "utf8"), previous);
  assert.equal(spawns, 0);
  await controller.close();
  // Only a completed owning config handoff permits normal unchanged adoption.
  await writeFile(file, directGatewayCaddyfile(settings));
  assert.equal(await controller.start(), settings.publicUrl);
  assert.equal(spawns, 0);
  await controller.close();
});

test("adopted direct gateway is relaunched after its health check fails", async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-gateway-recover-"));
  const settings = {
    publicUrl: "https://home.example.test",
    domain: "home.example.test",
    executable: path.join(workingDirectory, "caddy.exe"),
    localUrl: "http://127.0.0.1:8787",
    routes: [],
    workingDirectory,
  };
  await writeFile(path.join(workingDirectory, "Caddyfile"), directGatewayCaddyfile(settings));
  let healthy = true;
  let scheduled = null;
  let spawns = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    if (child.exitCode == null) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
    }
    return true;
  };
  const controller = new DirectGatewayController(settings, {
    probeImpl: async () => healthy,
    spawnImpl: () => {
      spawns += 1;
      return child;
    },
    startupGraceMs: 1,
    scheduleHealthCheckImpl: (callback, delayMs) => {
      scheduled = { callback, delayMs, unref() {} };
      return scheduled;
    },
    cancelHealthCheckImpl: (timer) => {
      if (scheduled === timer) scheduled = null;
    },
    logger: { log() {}, warn() {}, error() {} },
  });

  await controller.start();
  assert.equal(spawns, 0);
  assert.ok(scheduled);

  healthy = false;
  const healthCheck = scheduled.callback;
  await healthCheck();
  assert.equal(spawns, 1);
  assert.ok(scheduled);

  await controller.close();
  assert.equal(scheduled, null);
});
