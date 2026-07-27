import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { findQuickTunnelUrl, QuickTunnelController } from "./quick-tunnel.mjs";

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
    onUrl: (url) => published.push(url),
  });

  assert.equal(await controller.start(), "https://agent-hub-pilot.trycloudflare.com");
  assert.deepEqual(calls[0][1], [
    "tunnel",
    "--no-autoupdate",
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
