import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const THEME_CATALOG = JSON.stringify([{
  id: "orbit",
  name: "Orbit",
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function openProductionUi(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${THEME_CATALOG}</script></head>`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    if (url.pathname === "/work-log.css") {
      return route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    try {
      return route.fulfill({
        status: 200,
        contentType: contentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
}

test("production model selector displays Astra and emits its canonical ID", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
    await openProductionUi(page);
    await page.evaluate(() => {
      window.__modelIntents = [];
      document.addEventListener("agenthub:intent", (event) => {
        if (event.detail?.type === "selection:set") window.__modelIntents.push(event.detail);
      });
      window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent Hub" }]);
      window.AgentHub.setTasks([{
        id: "task-1",
        provider: "codex",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        workspaceName: "Agent Hub",
        streamId: "stream-1",
        streamName: "Диалоги",
        title: "Диалоги",
        agentLabel: "Codex",
        selected: true,
      }]);
      window.AgentHub.setOptions({
        modelOptionsByProvider: {
          codex: [
            { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
            { value: "gpt-6-astra", label: "GPT-6-Astra" },
          ],
        },
      });
      window.AgentHub.setSelection({
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning: "high",
        mode: "default",
      });
      window.AgentHub.showSelectedTask();
    });

    await page.locator("[data-dialog-settings-toggle]").click();
    const model = page.locator('select[data-dialog-options="model"]');
    assert.equal(await model.locator('option[value="gpt-6-astra"]').textContent(), "GPT-6-Astra");
    await page.locator('.themed-select:has(select[data-dialog-options="model"]) .themed-select-button').click();
    await page.locator('.themed-select-menu[aria-label="Модель"] [data-value="gpt-6-astra"]').click();
    assert.equal(await model.inputValue(), "gpt-6-astra");
    assert.deepEqual(await page.evaluate(() => window.__modelIntents.at(-1)), {
      type: "selection:set",
      key: "model",
      value: "gpt-6-astra",
    });
  } finally {
    await browser.close();
  }
});
