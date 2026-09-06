import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const TEST_THEME_CATALOG = JSON.stringify([{
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
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

async function openProductionAssets(page) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "agent-hub.test") {
      await route.abort();
      return;
    }
    if (requestUrl.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      return;
    }
    if (requestUrl.pathname === "/work-log.css") {
      await route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
      return;
    }
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    try {
      await route.fulfill({
        status: 200,
        contentType: contentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
}

test("shipped Desktop DOM renders every durable ImageGen output and a missing placeholder", async () => {
  const { chromium } = await import("playwright");
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await openProductionAssets(page);
    const result = await page.evaluate(() => {
      const taskId = "task-image-output";
      window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Workspace" }]);
      window.AgentHub.setTasks([{
        id: taskId,
        workspaceId: "workspace-1",
        workspaceName: "Workspace",
        streamId: "stream-1",
        streamName: "Images",
        title: "Images",
        provider: "codex",
        agentLabel: "Codex",
        modelLabel: "Sol",
        status: "ready",
        statusLabel: "Готов",
        selected: true,
      }]);
      window.AgentHub.setMessages(taskId, [{
        id: "turn-image",
        itemId: "turn-image:agent:final",
        turnId: "turn-image",
        role: "agent",
        text: "Три варианта",
        attachments: [
          { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
          { id: "codex-generated-two.png", name: "Изображение", type: "image/png" },
          {
            id: "codex-generated-three.png",
            name: "Изображение",
            type: "image/png",
            missing: true,
          },
        ],
      }]);
      const message = document.querySelector('.msg-agent[data-turn-id="turn-image"]');
      const attachments = [...message.querySelectorAll(".attachment-image")];
      return {
        messageCount: document.querySelectorAll('.msg-agent[data-turn-id="turn-image"]').length,
        attachmentCount: attachments.length,
        missingCount: attachments.filter((node) => node.classList.contains("attachment-missing")).length,
        missingDisabled: attachments.find((node) => node.classList.contains("attachment-missing"))?.disabled,
        missingLabel: message.querySelector(".attachment-missing-label")?.textContent,
      };
    });

    assert.deepEqual(result, {
      messageCount: 1,
      attachmentCount: 3,
      missingCount: 1,
      missingDisabled: true,
      missingLabel: "Файл недоступен",
    });
  } finally {
    await browser.close();
  }
});
