import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  callDesktopControl,
  desktopControlEndpoint,
  desktopControlEndpointFile,
  desktopControlSecretFile,
  DesktopControlServer,
  readDesktopControlEndpoint,
  validateDesktopControlEndpoint,
  validateDesktopControlRequest,
} from "../../desktop-control.mjs";
import { createDesktopControlRouter } from "../../src/interfaces/desktop/desktop-control-router.mjs";

test("desktop control validates endpoint and request shape", () => {
  const endpointId = "a".repeat(64);
  const descriptor = {
    protocol: 2,
    endpointId,
    pipeName: `agent-hub-desktop-${endpointId}`,
  };
  assert.deepEqual(validateDesktopControlEndpoint(descriptor), {
    protocol: 2,
    endpointId,
    pipeName: `agent-hub-desktop-${endpointId}`,
  });
  if (process.platform !== "win32") {
    const runtimeRoot = "/var/lib/agenthub/.local/state/agent-hub";
    const endpoint = desktopControlEndpoint(runtimeRoot, descriptor);
    assert.equal(endpoint, path.join(runtimeRoot, `desktop-${"a".repeat(24)}.sock`));
    assert.ok(Buffer.byteLength(endpoint, "utf8") < 108);
  }
  assert.throws(
    () => validateDesktopControlEndpoint({
      protocol: 2,
      endpointId,
      pipeName: "../attacker",
    }),
    /Invalid Desktop control endpoint/,
  );
  assert.deepEqual(validateDesktopControlRequest({
    action: "snapshot",
    params: {},
  }), { action: "snapshot", params: {} });
  assert.deepEqual(validateDesktopControlRequest({
    action: "send-message",
    params: {},
    commandId: "command-1",
  }), { action: "send-message", params: {}, commandId: "command-1" });
  assert.throws(
    () => validateDesktopControlRequest({ action: "../run" }),
    /Invalid desktop control action/,
  );
});

test("desktop control exchanges authenticated RPC and rotates endpoint after restart", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-control-"));
  const protectedFiles = [];
  const server = new DesktopControlServer({
    runtimeRoot,
    protectSecret: async (file) => { protectedFiles.push(path.basename(file)); },
    handler: async ({ action, params, context }) => ({
      action,
      source: context?.source,
      commandId: context?.commandId,
      value: params.value,
      tasks: ["один", "два"],
    }),
  });
  try {
    const staleEndpointId = "f".repeat(64);
    await writeFile(desktopControlEndpointFile(runtimeRoot), `${JSON.stringify({
      protocol: 2,
      endpointId: staleEndpointId,
      pipeName: `agent-hub-desktop-${staleEndpointId}`,
    })}\n`, "utf8");
    await server.start();
    const firstEndpoint = await readDesktopControlEndpoint(runtimeRoot);
    assert.match(firstEndpoint.endpointId, /^[a-f0-9]{64}$/);
    assert.notEqual(firstEndpoint.endpointId, staleEndpointId);
    assert.deepEqual(await callDesktopControl("snapshot", { value: 42 }, {
      runtimeRoot,
      commandId: "desktop-command-1",
    }), {
      action: "snapshot",
      source: "desktop-control",
      commandId: "desktop-command-1",
      value: 42,
      tasks: ["один", "два"],
    });
    assert.ok(protectedFiles.includes("desktop-control.secret"));
    assert.ok(protectedFiles.includes("desktop-control.endpoint.json"));

    await server.close();
    await assert.rejects(readFile(desktopControlEndpointFile(runtimeRoot), "utf8"), { code: "ENOENT" });
    await server.start();
    const secondEndpoint = await readDesktopControlEndpoint(runtimeRoot);
    assert.notEqual(secondEndpoint.endpointId, firstEndpoint.endpointId);
    assert.equal((await callDesktopControl("after-restart", {}, { runtimeRoot })).action, "after-restart");
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("desktop IPC retires delivered receipts and stays available beyond receipt capacity", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-capacity-"));
  const receiptFile = path.join(runtimeRoot, "receipts.json");
  let effects = 0;
  const router = createDesktopControlRouter({
    handlers: { mutate: async ({ index }) => ({ index, effect: ++effects }) },
    mutationActions: ["mutate"],
    receiptFile,
    receiptOptions: { maxItems: 100 },
  });
  const server = new DesktopControlServer({
    runtimeRoot,
    protectSecret: async () => {},
    handler: router.handleDesktopControl,
    onResultDelivered: ({ id }) => router.forgetDesktopControl(id),
  });
  try {
    await server.start();
    for (let index = 0; index < 110; index += 1) {
      assert.deepEqual(await callDesktopControl("mutate", { index }, {
        runtimeRoot,
        commandId: `ipc-command-${index}`,
      }), { index, effect: index + 1 });
    }
    assert.equal(effects, 110);
    assert.deepEqual(JSON.parse(await readFile(receiptFile, "utf8")).records, []);
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("desktop client reconnects when the endpoint rotates before connect", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-reconnect-"));
  const staleEndpointId = "e".repeat(64);
  const server = new DesktopControlServer({
    runtimeRoot,
    protectSecret: async () => {},
    handler: async ({ action }) => ({ action, reconnected: true }),
  });
  let delayedStart;
  try {
    await writeFile(desktopControlSecretFile(runtimeRoot), `${randomBytes(32).toString("hex")}\n`, "utf8");
    await writeFile(desktopControlEndpointFile(runtimeRoot), `${JSON.stringify({
      protocol: 2,
      endpointId: staleEndpointId,
      pipeName: `agent-hub-desktop-${staleEndpointId}`,
    })}\n`, "utf8");
    delayedStart = new Promise((resolve, reject) => {
      setTimeout(() => server.start().then(resolve, reject), 120);
    });
    assert.deepEqual(
      await callDesktopControl("snapshot", {}, { runtimeRoot, timeoutMs: 1_000 }),
      { action: "snapshot", reconnected: true },
    );
    await delayedStart;
  } finally {
    await delayedStart?.catch(() => {});
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("desktop client rejects a squatting server before disclosing a client proof", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-squatter-"));
  const endpointId = randomBytes(32).toString("hex");
  const descriptor = {
    protocol: 2,
    endpointId,
    pipeName: `agent-hub-desktop-${endpointId}`,
  };
  const lines = [];
  await writeFile(desktopControlSecretFile(runtimeRoot), `${randomBytes(32).toString("hex")}\n`, "utf8");
  await writeFile(desktopControlEndpointFile(runtimeRoot), `${JSON.stringify(descriptor)}\n`, "utf8");
  const fake = createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      const line = body.slice(0, newline);
      body = body.slice(newline + 1);
      lines.push(JSON.parse(line));
      if (lines.length === 1) {
        socket.write(`${JSON.stringify({
          type: "challenge",
          protocol: 2,
          endpointId,
          challenge: randomBytes(32).toString("hex"),
          serverProof: "0".repeat(64),
        })}\n`);
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      fake.once("error", reject);
      fake.listen({
        path: desktopControlEndpoint(runtimeRoot, descriptor),
        exclusive: true,
        readableAll: false,
        writableAll: false,
      }, resolve);
    });
    await assert.rejects(
      callDesktopControl("snapshot", {}, { runtimeRoot, timeoutMs: 1_000 }),
      /server authentication failed/,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, "hello");
    assert.equal(Object.hasOwn(lines[0], "secret"), false);
    assert.equal(Object.hasOwn(lines[0], "proof"), false);
  } finally {
    await new Promise((resolve) => fake.close(resolve));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("desktop server refuses requests that skip the challenge-response handshake", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-handshake-"));
  const server = new DesktopControlServer({
    runtimeRoot,
    protectSecret: async () => {},
    handler: async () => ({ unreachable: true }),
  });
  try {
    await server.start();
    const descriptor = await readDesktopControlEndpoint(runtimeRoot);
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(desktopControlEndpoint(runtimeRoot, descriptor));
      let body = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({
          type: "request",
          payload: Buffer.from("{}").toString("base64"),
          proof: "0".repeat(64),
        })}\n`);
      });
      socket.on("data", (chunk) => { body += chunk; });
      socket.on("error", reject);
      socket.on("close", () => resolve(JSON.parse(body)));
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /handshake required/);
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("desktop server refuses an invalid client proof without invoking the handler", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-client-proof-"));
  let handlerCalls = 0;
  const server = new DesktopControlServer({
    runtimeRoot,
    protectSecret: async () => {},
    handler: async () => {
      handlerCalls += 1;
      return { unreachable: true };
    },
  });
  try {
    await server.start();
    const descriptor = await readDesktopControlEndpoint(runtimeRoot);
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(desktopControlEndpoint(runtimeRoot, descriptor));
      const clientNonce = randomBytes(32).toString("hex");
      let body = "";
      let sentRequest = false;
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "hello", protocol: 2, clientNonce })}\n`);
      });
      socket.on("data", (chunk) => {
        body += chunk;
        const newline = body.indexOf("\n");
        if (newline < 0) return;
        const message = JSON.parse(body.slice(0, newline));
        body = body.slice(newline + 1);
        if (!sentRequest) {
          sentRequest = true;
          socket.write(`${JSON.stringify({
            type: "request",
            clientNonce,
            challenge: message.challenge,
            payload: Buffer.from(JSON.stringify({ action: "snapshot", params: {} })).toString("base64"),
            proof: "0".repeat(64),
          })}\n`);
          return;
        }
        resolve(message);
      });
      socket.on("error", reject);
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /client authentication failed/);
    assert.equal(handlerCalls, 0);
  } finally {
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("desktop client fails with a bounded timeout when the server stalls", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-timeout-"));
  const endpointId = randomBytes(32).toString("hex");
  const descriptor = {
    protocol: 2,
    endpointId,
    pipeName: `agent-hub-desktop-${endpointId}`,
  };
  await writeFile(desktopControlSecretFile(runtimeRoot), `${randomBytes(32).toString("hex")}\n`, "utf8");
  await writeFile(desktopControlEndpointFile(runtimeRoot), `${JSON.stringify(descriptor)}\n`, "utf8");
  const sockets = new Set();
  const stalled = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      stalled.once("error", reject);
      stalled.listen({
        path: desktopControlEndpoint(runtimeRoot, descriptor),
        exclusive: true,
        readableAll: false,
        writableAll: false,
      }, resolve);
    });
    const startedAt = Date.now();
    await assert.rejects(
      callDesktopControl("snapshot", {}, { runtimeRoot, timeoutMs: 120 }),
      /timed out/,
    );
    assert.ok(Date.now() - startedAt < 1_500);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => stalled.close(resolve));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("desktop server shutdown destroys a partial half-closed client", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-partial-"));
  const server = new DesktopControlServer({
    runtimeRoot,
    handler: async () => ({}),
    protectSecret: async () => {},
  });
  let socket;
  try {
    await server.start();
    const descriptor = await readDesktopControlEndpoint(runtimeRoot);
    socket = createConnection(desktopControlEndpoint(runtimeRoot, descriptor));
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("{");
    const startedAt = Date.now();
    await server.close();
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(socket.destroyed, true);
  } finally {
    socket?.destroy();
    await server.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
