import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callDesktopControl,
  DesktopControlServer,
  validateDesktopControlRequest,
} from "./desktop-control.mjs";

test("desktop control validates authentication and request shape", () => {
  assert.deepEqual(validateDesktopControlRequest({
    secret: "a".repeat(32),
    action: "snapshot",
    params: {},
  }, "a".repeat(32)), { action: "snapshot", params: {} });
  assert.throws(
    () => validateDesktopControlRequest({ secret: "wrong", action: "snapshot" }, "a".repeat(32)),
    /authentication failed/,
  );
  assert.throws(
    () => validateDesktopControlRequest({ secret: "a".repeat(32), action: "../run" }, "a".repeat(32)),
    /Invalid desktop control action/,
  );
});

test("desktop control exchanges structured local RPC responses", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "tyrael-desktop-control-"));
  const server = new DesktopControlServer({
    runtimeRoot,
    protectSecret: async () => {},
    handler: async ({ action, params }) => ({ action, value: params.value, tasks: ["один", "два"] }),
  });
  try {
    await server.start();
    assert.deepEqual(await callDesktopControl("snapshot", { value: 42 }, { runtimeRoot }), {
      action: "snapshot",
      value: 42,
      tasks: ["один", "два"],
    });
    await server.close();
    await server.start();
    assert.equal((await callDesktopControl("after-restart", {}, { runtimeRoot })).action, "after-restart");
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
