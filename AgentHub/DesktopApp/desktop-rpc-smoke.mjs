import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  desktopControlEndpoint,
  desktopControlEndpointFile,
  desktopControlSecretFile,
  DesktopControlServer,
} from "../desktop-control.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const executable = path.join(directory, "dist", "AgentHub.exe");
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-csharp-smoke-"));
const messageIds = [];
let sendAttempts = 0;
let fakeServer = null;
const server = new DesktopControlServer({
  runtimeRoot,
  protectSecret: async () => {},
  handler: async ({ action, params }) => {
    if (action === "desktop-smoke") {
      return { value: params.value, text: params.text };
    }
    if (action === "send-message") {
      sendAttempts += 1;
      messageIds.push(String(params.clientUserMessageId ?? ""));
      if (sendAttempts === 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { accepted: true, clientUserMessageId: params.clientUserMessageId };
    }
    throw new Error(`Unexpected smoke action: ${action}`);
  },
});

function runDesktop(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, {
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Desktop C# RPC smoke timed out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

try {
  const staleEndpointId = "d".repeat(64);
  await writeFile(desktopControlSecretFile(runtimeRoot), `${randomBytes(32).toString("hex")}\n`, "utf8");
  await writeFile(desktopControlEndpointFile(runtimeRoot), `${JSON.stringify({
    protocol: 2,
    endpointId: staleEndpointId,
    pipeName: `agent-hub-desktop-${staleEndpointId}`,
  })}\n`, "utf8");
  const delayedStart = new Promise((resolve, reject) => {
    setTimeout(() => server.start().then(resolve, reject), 120);
  });
  const exitCode = await runDesktop(["--rpc-smoke", runtimeRoot]);
  await delayedStart;
  assert.equal(exitCode, 0);
  assert.equal(sendAttempts, 2);
  assert.equal(messageIds.length, 2);
  assert.match(messageIds[0], /^[a-f0-9-]{36}$/i);
  assert.equal(messageIds[1], messageIds[0]);
  await server.close();

  const endpointId = randomBytes(32).toString("hex");
  const descriptor = {
    protocol: 2,
    endpointId,
    pipeName: `agent-hub-desktop-${endpointId}`,
  };
  const fakeMessages = [];
  await writeFile(desktopControlSecretFile(runtimeRoot), `${randomBytes(32).toString("hex")}\n`, "utf8");
  await writeFile(desktopControlEndpointFile(runtimeRoot), `${JSON.stringify(descriptor)}\n`, "utf8");
  fakeServer = createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(body.slice(0, newline));
      fakeMessages.push(message);
      socket.write(`${JSON.stringify({
        type: "challenge",
        protocol: 2,
        endpointId,
        challenge: randomBytes(32).toString("hex"),
        serverProof: "0".repeat(64),
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    fakeServer.once("error", reject);
    fakeServer.listen({
      path: desktopControlEndpoint(runtimeRoot, descriptor),
      exclusive: true,
      readableAll: false,
      writableAll: false,
    }, resolve);
  });
  assert.equal(await runDesktop(["--rpc-smoke", runtimeRoot]), 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fakeMessages.length, 1);
  assert.equal(fakeMessages[0].type, "hello");
  assert.equal(Object.hasOwn(fakeMessages[0], "secret"), false);
  assert.equal(Object.hasOwn(fakeMessages[0], "proof"), false);
  process.stdout.write("Desktop C# RPC and squatting-defense smoke passed\n");
} finally {
  await server.close();
  if (fakeServer) await new Promise((resolve) => fakeServer.close(resolve));
  await rm(runtimeRoot, { recursive: true, force: true });
}
