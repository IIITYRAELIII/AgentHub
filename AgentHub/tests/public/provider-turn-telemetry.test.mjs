import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function telemetryApi(runtime = {}) {
  const source = await readFile(new URL("../../assets/web-app/provider-turn-telemetry.js", import.meta.url), "utf8");
  const window = runtime.window ?? {};
  vm.runInNewContext(source, { ...runtime, window });
  return window.AgentHubProviderTurnTelemetry;
}

function fakeElement({ open = false, hidden = false } = {}) {
  const listeners = new Map();
  return {
    open,
    hidden,
    dataset: {},
    style: {},
    attributes: new Map(),
    children: [],
    textContent: "",
    offsetWidth: 120,
    offsetHeight: 40,
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    emit(type) {
      for (const listener of listeners.get(type) ?? []) listener({ target: this });
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    replaceChildren(...children) {
      this.children = children;
    },
    toggleAttribute(name, force) {
      if (force) this.attributes.set(name, "");
      else this.attributes.delete(name);
    },
    append(...children) {
      this.children.push(...children);
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    getBoundingClientRect() {
      return { left: 0, bottom: 0 };
    },
  };
}

test("turn timeline stays ordered and uses the provider baseline", async () => {
  const { derivedTimeline } = await telemetryApi();
  const rows = derivedTimeline({
    turnStartedAtMs: 1_000,
    timeline: [
      { atMs: 4_000, type: "first-visible" },
      { atMs: 2_000, type: "first-content" },
    ],
  }, {});
  assert.deepEqual(rows.map((row) => row.elapsed), [1_000, 3_000]);
  assert.deepEqual(rows.map((row) => row.label), ["Первый текст от модели", "Первый видимый ответ"]);
});

test("turn history is populated immediately when the indicator opens it", async () => {
  const indicator = fakeElement();
  const tooltip = fakeElement({ hidden: true });
  const tooltipText = fakeElement();
  const dialog = fakeElement();
  const summary = fakeElement();
  const metrics = fakeElement();
  const timeline = fakeElement();
  const close = fakeElement();
  const window = { innerWidth: 1_000, innerHeight: 800, addEventListener() {} };
  const document = { createElement: () => fakeElement() };
  const { createController } = await telemetryApi({
    window,
    document,
    clearTimeout,
    setTimeout,
    requestAnimationFrame: (callback) => callback(),
  });
  const controller = createController({ indicator, tooltip, tooltipText, dialog, summary, metrics, timeline, close });
  controller.update({
    title: "Codex ↔ модель: отличная\nФаза: завершён",
    providerStart: { turnStartedAtMs: 1_000, timeline: [{ atMs: 2_000, type: "first-content" }] },
    measurement: { firstContentMs: 1_000 },
  });

  indicator.emit("click");

  assert.equal(dialog.open, true);
  assert.equal(summary.textContent, "Codex ↔ модель: отличная");
  assert.deepEqual(metrics.children.map((item) => item.textContent), ["Фаза: завершён"]);
  assert.equal(timeline.children.length, 1);
});
