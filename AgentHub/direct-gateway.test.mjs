import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { directGatewayCaddyfile, loadDirectGatewaySettings } from "./direct-gateway.mjs";

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
