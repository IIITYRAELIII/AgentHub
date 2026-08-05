import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { directGatewayCaddyfile, loadDirectGatewaySettings } from "./src/interfaces/web/direct-gateway.mjs";

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
