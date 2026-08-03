import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function disclosureApi() {
  const source = await readFile(new URL("./assets/mini-app/message-disclosure.js", import.meta.url), "utf8");
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

test("shared shell keeps full text and limits only the rendered user-message body", async () => {
  const app = await readFile(new URL("./assets/mini-app/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("./assets/mini-app/styles.css", import.meta.url), "utf8");
  assert.match(app, /body\.scrollHeight, USER_MESSAGE_COLLAPSE_HEIGHT_PX/u);
  assert.match(app, /textContent = expanded \? "Свернуть" : "Показать ещё"/u);
  assert.match(styles, /\.msg-user \.msg-body\.is-collapsed[\s\S]*max-height/u);
  assert.match(styles, /html\[data-surface="mobile"\] \.msg-disclosure[\s\S]*min-height: 2\.75rem/u);
});
