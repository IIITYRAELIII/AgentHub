import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const TRUST_URL = new URL("../../assets/web-app/host-message-trust.js", import.meta.url);

async function hostMessageTrust() {
  const window = {};
  vm.runInNewContext(await readFile(TRUST_URL, "utf8"), { window });
  return { api: window.AgentHubHostMessageTrust, window };
}

test("host-message boundary accepts only the native host and Agent Hub window", async () => {
  const { api, window } = await hostMessageTrust();
  const activeFrame = {};
  const oldFrame = {};
  const nestedFrame = {};
  api.registerEmbeddedFrame({ contentWindow: oldFrame });
  api.registerEmbeddedFrame({ contentWindow: activeFrame });

  const received = [];
  const guarded = api.guardHostMessage((event) => received.push(event.data.type), window);
  guarded({ source: activeFrame, data: { type: "agenthub:runtime-published" } });
  guarded({ source: oldFrame, data: { type: "agenthub:control-result" } });
  guarded({ source: nestedFrame, data: { type: "agenthub:session-result" } });
  guarded({ source: window, data: { type: "agenthub:self" } });
  guarded({ source: null, data: { type: "agenthub:host" } });

  assert.deepEqual(received, ["agenthub:self", "agenthub:host"]);
  assert.equal(api.isTrustedAgentHubHostMessage({ source: activeFrame }, window), false);
  assert.equal(api.isTrustedAgentHubHostMessage({ source: oldFrame }, window), false);
  assert.equal(api.isTrustedAgentHubHostMessage({ source: nestedFrame }, window), false);
});

test("active and replaced frame messages cannot request a runtime reload", async () => {
  const { api, window } = await hostMessageTrust();
  const oldFrame = {};
  const activeFrame = {};
  api.registerEmbeddedFrame({ contentWindow: oldFrame });
  api.registerEmbeddedFrame({ contentWindow: activeFrame });
  let reloads = 0;
  const receiveRuntimeMessage = api.guardHostMessage((event) => {
    if (event.data?.type === "agenthub:runtime-published") reloads += 1;
  }, window);

  receiveRuntimeMessage({ source: oldFrame, data: { type: "agenthub:runtime-published" } });
  receiveRuntimeMessage({ source: activeFrame, data: { type: "agenthub:runtime-published" } });
  assert.equal(reloads, 0);

  receiveRuntimeMessage({ source: null, data: { type: "agenthub:runtime-published" } });
  assert.equal(reloads, 1);
});

test("current VS Code wrapper source completes host control without trusting web frames", async () => {
  const vscodeWindow = {
    __agentHubVscode: Object.freeze({ postMessage() {} }),
    location: {
      origin: "vscode-webview://current-panel",
      protocol: "vscode-webview:",
    },
  };
  const { api } = await hostMessageTrust();
  const vscodeHostWrapper = {};
  const embeddedFrame = {};
  const unrelatedFrame = {};
  api.registerEmbeddedFrame({ contentWindow: embeddedFrame });

  const received = [];
  const guarded = api.guardHostMessage((event) => received.push(event.data), vscodeWindow);
  const hostResult = {
    type: "agenthub:control-result",
    id: "bridge-resolve-image",
    ok: true,
    result: { url: "https://file+.vscode-resource.vscode-cdn.net/generated.png" },
  };
  guarded({
    source: vscodeHostWrapper,
    origin: vscodeWindow.location.origin,
    data: hostResult,
  });
  guarded({
    source: embeddedFrame,
    origin: vscodeWindow.location.origin,
    data: { type: "agenthub:control-result", id: "forged-registered-frame" },
  });
  guarded({
    source: unrelatedFrame,
    origin: "https://remote.example.org",
    data: { type: "agenthub:control-result", id: "foreign-origin" },
  });

  assert.deepEqual(received, [hostResult]);
  assert.equal(api.isTrustedAgentHubHostMessage({
    source: vscodeHostWrapper,
    origin: vscodeWindow.location.origin,
  }, vscodeWindow), true);
  assert.equal(api.isTrustedAgentHubHostMessage({
    source: embeddedFrame,
    origin: vscodeWindow.location.origin,
  }, vscodeWindow), false);
  assert.equal(api.isTrustedAgentHubHostMessage({
    source: unrelatedFrame,
    origin: "https://remote.example.org",
  }, vscodeWindow), false);

  const ordinaryWindow = {
    __agentHubVscode: vscodeWindow.__agentHubVscode,
    location: { origin: "https://agent-hub.test", protocol: "https:" },
  };
  assert.equal(api.isTrustedAgentHubHostMessage({
    source: unrelatedFrame,
    origin: ordinaryWindow.location.origin,
  }, ordinaryWindow), false);
});
