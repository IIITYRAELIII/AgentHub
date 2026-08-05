import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { findQuickTunnelUrl, QuickTunnelController } from "./src/infrastructure/network/quick-tunnel.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  };
  return child;
}

test("findQuickTunnelUrl extracts only a TryCloudflare HTTPS URL", () => {
  assert.equal(
    findQuickTunnelUrl("INF Your quick Tunnel has been created! https://pilot-test.trycloudflare.com"),
    "https://pilot-test.trycloudflare.com",
  );
  assert.equal(findQuickTunnelUrl("http://pilot-test.trycloudflare.com"), null);
  assert.equal(findQuickTunnelUrl("https://example.com"), null);
});

test("QuickTunnelController starts cloudflared, publishes the URL and closes it", async () => {
  const child = fakeChild();
  const calls = [];
  const published = [];
  const controller = new QuickTunnelController({
    executable: "cloudflared.exe",
    localUrl: "http://127.0.0.1:8787",
    spawnImpl: (...args) => {
      calls.push(args);
      queueMicrotask(() => child.stderr.write(
        "INF https://agent-hub-pilot.trycloudflare.com is ready\n",
      ));
      return child;
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    onUrl: (url) => published.push(url),
  });

  assert.equal(await controller.start(), "https://agent-hub-pilot.trycloudflare.com");
  assert.deepEqual(calls[0][1], [
    "tunnel",
    "--no-autoupdate",
    "--protocol",
    "http2",
    "--url",
    "http://127.0.0.1:8787",
  ]);
  assert.equal(calls[0][2].windowsHide, true);
  assert.deepEqual(published, ["https://agent-hub-pilot.trycloudflare.com"]);
  await controller.close();
  assert.equal(child.exitCode, 0);
});

test("QuickTunnelController reports an early cloudflared exit", async () => {
  const child = fakeChild();
  const controller = new QuickTunnelController({
    localUrl: "http://127.0.0.1:8787",
    spawnImpl: () => {
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    },
  });
  await assert.rejects(controller.start(), /exited before startup/u);
});

test("QuickTunnelController terminates a tunnel when startup times out", async () => {
  const child = fakeChild();
  let kills = 0;
  child.kill = () => {
    kills += 1;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  };
  const controller = new QuickTunnelController({
    localUrl: "http://127.0.0.1:8787",
    timeoutMs: 10,
    spawnImpl: () => child,
  });

  await assert.rejects(controller.start(), /did not publish/u);
  assert.equal(kills, 1);
  assert.equal(child.exitCode, 0);
});

test("QuickTunnelController terminates a published tunnel when URL registration fails", async () => {
  const child = fakeChild();
  const controller = new QuickTunnelController({
    localUrl: "http://127.0.0.1:8787",
    spawnImpl: () => {
      queueMicrotask(() => child.stderr.write("https://agent-hub-pilot.trycloudflare.com\n"));
      return child;
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    onUrl: async () => { throw new Error("cannot register menu button"); },
  });

  await assert.rejects(controller.start(), /cannot register/u);
  assert.equal(child.exitCode, 0);
});

test("QuickTunnelController starts a named Cloudflare Tunnel from a token file", async () => {
  const child = fakeChild();
  const calls = [];
  const published = [];
  const controller = new QuickTunnelController({
    executable: "cloudflared.exe",
    mode: "named",
    publicUrl: "https://hub.example.test",
    tokenFile: "C:\\AgentHub\\cloudflare-tunnel.token",
    edgeBindAddress: "192.0.2.10",
    localUrl: "http://127.0.0.1:8788",
    spawnImpl: (...args) => {
      calls.push(args);
      queueMicrotask(() => child.stderr.write("INF Registered tunnel connection\n"));
      return child;
    },
    fetchImpl: async () => {
      throw new Error("Named Tunnel startup must not depend on public DNS");
    },
    onUrl: (url) => published.push(url),
  });

  assert.equal(await controller.start(), "https://hub.example.test");
  assert.deepEqual(calls[0][1], [
    "tunnel",
    "--no-autoupdate",
    "--protocol",
    "http2",
    "--edge-bind-address",
    "192.0.2.10",
    "run",
    "--token-file",
    "C:\\AgentHub\\cloudflare-tunnel.token",
  ]);
  assert.deepEqual(published, ["https://hub.example.test"]);
  await controller.close();
});

test("QuickTunnelController discovers a Pinggy URL through its local debugger API", async () => {
  const child = fakeChild();
  const requests = [];
  const controller = new QuickTunnelController({
    provider: "pinggy",
    executable: "ssh",
    localUrl: "http://127.0.0.1:8788/",
    controlPort: 4300,
    spawnImpl: (...args) => {
      requests.push({ spawn: args });
      return child;
    },
    fetchImpl: async (url) => {
      requests.push({ fetch: url });
      if (url.includes("127.0.0.1:4300")) {
        return {
          ok: true,
          json: async () => ({
            urls: ["https://pilot.free.pinggy.net"],
          }),
        };
      }
      return { ok: true, status: 200 };
    },
  });

  assert.equal(await controller.start(), "https://pilot.free.pinggy.net");
  assert.deepEqual(requests[0].spawn[1], [
    "-p",
    "443",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-T",
    "-R0:127.0.0.1:8788",
    "-L4300:127.0.0.1:4300",
    "free.pinggy.io",
  ]);
  await controller.close();
});
