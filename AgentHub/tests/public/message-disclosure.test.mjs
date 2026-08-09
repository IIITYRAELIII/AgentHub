import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function disclosureApi() {
  const source = await readFile(new URL("../../assets/mini-app/message-disclosure.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubMessageDisclosure;
}

test("user message disclosure appears only for real visual overflow", async () => {
  const { USER_MESSAGE_COLLAPSE_HEIGHT_PX: height, hasCollapsedOverflow } = await disclosureApi();
  assert.equal(hasCollapsedOverflow(height), false);
  assert.equal(hasCollapsedOverflow(height - 1), false);
  assert.equal(hasCollapsedOverflow(height + 1), true);
});

test("live activity disclosure starts closed and preserves only a manual opening", async () => {
  const { liveActivityDisclosureOpen } = await disclosureApi();
  assert.equal(liveActivityDisclosureOpen({ open: true, wasHidden: true, visible: true }), false);
  assert.equal(liveActivityDisclosureOpen({ open: true, wasHidden: false, visible: true }), true);
  assert.equal(liveActivityDisclosureOpen({ open: true, wasHidden: false, visible: false }), false);
});

test("live stage is rendered in the current activity title", async () => {
  const { liveActivityTitle, liveStageParts } = await disclosureApi();
  const stage = liveStageParts("Ход выполняется · Анализирую задачу…");
  assert.equal(stage.status, "Ход выполняется");
  assert.equal(stage.detail, "Анализирую задачу…");
  assert.equal(
    liveActivityTitle({ count: 3, stage: "Анализирую задачу…" }),
    "Вызовы инструментов (3) · Анализирую задачу…",
  );
  assert.equal(
    liveActivityTitle({ label: "Выполненные действия", count: 2 }),
    "Выполненные действия (2)",
  );
});

test("shared shell keeps full text and limits only the rendered user-message body", async () => {
  const app = await readFile(new URL("../../assets/mini-app/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../assets/mini-app/styles.css", import.meta.url), "utf8");
  assert.match(app, /body\.scrollHeight, USER_MESSAGE_COLLAPSE_HEIGHT_PX/u);
  assert.match(app, /textContent = expanded \? "Свернуть" : "Показать ещё"/u);
  assert.match(styles, /\.msg-user \.msg-body\.is-collapsed[\s\S]*max-height/u);
  assert.match(styles, /html\[data-surface="mobile"\] \.msg-disclosure[\s\S]*min-height: 2\.75rem/u);
});
