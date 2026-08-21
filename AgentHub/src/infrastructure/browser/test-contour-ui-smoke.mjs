import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const TEST_CONTOUR_PROBE = "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";
export const TEST_CONTOUR_PROBE_RESPONSE = "AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";

function playwrightRuntime(automationRoot) {
  const require = createRequire(path.join(automationRoot, "package.json"));
  return require("playwright-core");
}

export async function runTestContourUiSmoke({
  url,
  automationRoot,
  artifactsDirectory,
  withAgent = true,
  timeoutMs = 180_000,
  launchOptions = { channel: "msedge", headless: true },
} = {}) {
  if (!url) throw new Error("Test Contour URL is required");
  const { chromium } = playwrightRuntime(automationRoot);
  await mkdir(artifactsDirectory, { recursive: true });
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response ${response.status()}: ${response.url()}`);
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator("[data-workspace]").waitFor({ state: "visible", timeout: timeoutMs });
    const title = await page.title();
    if (title !== "Agent Hub") throw new Error(`Unexpected Test Contour title: ${title}`);
    const bodyText = (await page.locator("body").innerText()).trim();
    if (bodyText.length < 100 || !bodyText.includes("Диалоги")) {
      throw new Error("Agent Hub shell did not render meaningful content");
    }

    await page.locator('[data-view-button="dashboard"]').click();
    await page.locator('html[data-view="dashboard"]').waitFor({ state: "attached", timeout: 10_000 });
    await page.locator('[data-view-button="chat"]').click();
    await page.locator('html[data-view="chat"]').waitFor({ state: "attached", timeout: 10_000 });

    if (withAgent) {
      const workspace = page.locator("[data-workspace-select]:visible").first();
      await workspace.waitFor({ state: "visible", timeout: timeoutMs });
      await workspace.click();
      const selectedStream = page.locator("[data-stream-tab-id]:visible").first();
      await selectedStream.waitFor({ state: "visible", timeout: timeoutMs });
      const previousUrl = page.url();
      await selectedStream.click({ button: "right" });
      const continueInCodex = page.locator(
        '[data-stream-menu-action="continue-provider"][data-provider="codex"]',
      );
      await continueInCodex.waitFor({ state: "visible", timeout: timeoutMs });
      await continueInCodex.click();
      await page.waitForFunction((previous) => (
        window.location.href !== previous && window.location.hash.includes("/chat/codex/")
      ), previousUrl, { timeout: timeoutMs });
      const input = page.locator("[data-composer-input]");
      await input.waitFor({ state: "visible", timeout: timeoutMs });
      await input.fill(TEST_CONTOUR_PROBE);
      await page.locator("[data-composer-send]").click();
      const response = page.locator(".msg-agent .msg-body")
        .filter({ hasText: TEST_CONTOUR_PROBE_RESPONSE })
        .last();
      await response.waitFor({ state: "visible", timeout: timeoutMs });
      const responseText = (await response.innerText()).trim();
      if (responseText !== TEST_CONTOUR_PROBE_RESPONSE) {
        throw new Error(`Unexpected Spark response: ${JSON.stringify(responseText)}`);
      }
    }

    const screenshot = path.join(artifactsDirectory, "ui-smoke.png");
    await page.screenshot({ path: screenshot, fullPage: false });
    if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`);
    return { title, screenshot, withAgent, errors: [] };
  } finally {
    await browser.close();
  }
}
