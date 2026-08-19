import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadController() {
  const source = fs.readFileSync(path.join(root, "assets/web-app/particle-style-controller.js"), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubParticleStyle;
}

test("particle parameters use a nonce stylesheet instead of blocked inline styles", () => {
  const controller = loadController();
  const layer = { prepend(value) { this.style = value; } };
  const documentRef = {
    createElement: () => ({ dataset: {} }),
    querySelector: () => ({ nonce: "webview-nonce" }),
  };

  const style = controller.install(documentRef, layer, [{
    "--x": "42%",
    "--dur": "1.2s",
  }]);

  assert.equal(style.nonce, "webview-nonce");
  assert.equal(style.dataset.agentHubParticleParameters, "");
  assert.equal(
    style.textContent,
    "[data-agent-hub-particles] > span:nth-of-type(1){--x:42%;--dur:1.2s}",
  );
  assert.equal(layer.style, style);
});

test("particle stylesheet rejects values that can escape a CSS declaration", () => {
  const controller = loadController();
  assert.throws(
    () => controller.parameterRules([{ "--x": "1%;color:red" }]),
    /Некорректный параметр/u,
  );
});
