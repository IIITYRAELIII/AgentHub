import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("failed startup exposes details and retry/restart controls inside the overlay", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true } : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const health = {
      ready: false, status: "unready",
      startup: {
        startedAtMs: 1000, completedAtMs: 42000,
        operations: [
          { id: "web", label: "Web", state: "completed" },
          { id: "provider", label: "Инициализация провайдера", state: "failed", error: "Signature check timed out <not markup>" },
        ],
      },
    };
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "startup.test") return route.abort();
      if (url.pathname === "/") return route.fulfill({
        contentType: "text/html", body: '<link rel="stylesheet" href="/startup-screen.css"><script type="module" src="/startup-screen.js"></script>',
      });
      if (url.pathname === "/health") return route.fulfill({ json: health });
      const name = url.pathname.slice(1);
      if (!["startup-screen.js", "startup-screen-model.js", "startup-screen.css", "agent-hub-mark.png"].includes(name)) return route.abort();
      return route.fulfill({
        contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "image/png",
        body: await readFile(new URL(`../../assets/web-app/${name}`, import.meta.url)),
      });
    });
    await page.addInitScript(() => {
      window.recoveryRequests = [];
      document.addEventListener("agenthub:startup-recovery", (event) => {
        window.recoveryRequests.push(event.detail);
        document.dispatchEvent(new CustomEvent("agenthub:startup-recovery-result", {
          detail: { message: "Запрос принят" },
        }));
      });
    });
    await page.goto("https://startup.test/");
    const screen = page.locator(".hub-startup-screen");
    await screen.waitFor({ state: "visible" });
    assert.match(await page.locator(".hub-startup-errors").innerText(), /Signature check timed out <not markup>/u);
    assert.equal(await page.locator(".hub-startup-errors not").count(), 0);
    await page.getByRole("button", { name: "Повторить упавшие этапы" }).click();
    await page.getByRole("button", { name: "Перезапустить Хаб" }).click();
    assert.deepEqual(await page.evaluate(() => window.recoveryRequests), [
      { action: "retry-startup", startedAtMs: 1000 },
      { action: "restart-server", startedAtMs: 1000 },
    ]);
    assert.equal(await page.locator(".hub-startup-timer").innerText(), "00:00:41");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agenthub:connection-state", {
      detail: { status: "restarting" },
    })));
    await page.locator(".hub-startup-screen.is-disconnected").waitFor({ state: "visible" });
    assert.doesNotMatch(await screen.innerText(), /Если сервер остановлен|установленный ярлык|Перезагрузка компьютера не нужна/u);
    assert.equal(await page.getByRole("button", { name: "Перезапустить Хаб" }).isDisabled(), true);
    assert.deepEqual(errors, []);
    if (process.env.STARTUP_QA_SCREENSHOT) await page.screenshot({ path: process.env.STARTUP_QA_SCREENSHOT });
  } finally {
    await browser.close();
  }
});
