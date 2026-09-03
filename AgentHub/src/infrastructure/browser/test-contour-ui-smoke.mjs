import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const TEST_CONTOUR_PROBE = "Ответь строго: AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";
export const TEST_CONTOUR_PROBE_RESPONSE = "AGENT_HUB_TEST_CONTOUR_SPARK_OK_V1";

export function exactTestContourResponsePattern(response) {
  const escaped = String(response ?? "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*$`, "u");
}

export function isTestContourModelSettingResponse(response, model) {
  if (!response?.url?.().endsWith("/api/control") || response.request?.().method?.() !== "POST") return false;
  try {
    const payload = JSON.parse(response.request().postData() || "{}");
    return payload.action === "update-setting"
      && payload.params?.name === "model"
      && payload.params?.value === model;
  } catch {
    return false;
  }
}

export async function selectTestContourModel(page, model, timeoutMs) {
  const normalizedModel = String(model ?? "").trim();
  if (!normalizedModel) throw new Error("Test Contour smoke model is required");
  const settingsToggle = page.locator("[data-dialog-settings-toggle]");
  await settingsToggle.waitFor({ state: "visible", timeout: timeoutMs });
  await settingsToggle.click();
  const modelSelect = page.locator('select[data-dialog-options="model"]');
  await modelSelect.waitFor({ state: "attached", timeout: timeoutMs });
  await modelSelect.locator(`option[value="${normalizedModel}"]`)
    .waitFor({ state: "attached", timeout: timeoutMs })
    .catch(() => {});
  const availableModels = await modelSelect.locator("option").evaluateAll((options) => (
    options.map((option) => String(option.value))
  ));
  if (!availableModels.includes(normalizedModel)) {
    throw new Error(
      `Test Contour model is not selectable: ${normalizedModel}; available=${availableModels.join(",")}`,
    );
  }
  if (await modelSelect.inputValue() === normalizedModel) {
    await page.locator("[data-dialog-settings-close]").click();
    return;
  }
  const settingResponse = page.waitForResponse(
    (response) => isTestContourModelSettingResponse(response, normalizedModel),
    { timeout: timeoutMs },
  );
  await modelSelect.selectOption(normalizedModel, { force: true });
  if (await modelSelect.inputValue() !== normalizedModel) {
    throw new Error(`Test Contour did not select model: ${normalizedModel}`);
  }
  const response = await settingResponse;
  if (!response.ok()) throw new Error(`Test Contour model setting failed: HTTP ${response.status()}`);
  await page.locator("[data-dialog-settings-close]").click();
}

export async function selectTestContourCodexStream(page, timeoutMs) {
  const workspaces = page.locator("[data-workspace-select]:visible");
  await workspaces.first().waitFor({ state: "visible", timeout: timeoutMs });
  const workspaceCount = await workspaces.count();
  for (let index = 0; index < workspaceCount; index += 1) {
    const workspace = workspaces.nth(index);
    const workspaceId = String(await workspace.getAttribute("data-workspace-id") ?? "").trim();
    if (!workspaceId) continue;
    await workspace.click();
    const stream = page.locator(
      `[data-stream-tab-id][data-workspace-id="${workspaceId}"]`
      + '[data-stream-provider="codex"]'
      + '[data-stream-name]:not([data-stream-name=""]):visible',
    ).first();
    const available = await stream.waitFor({
      state: "visible",
      timeout: Math.min(timeoutMs, 2_000),
    }).then(() => true, () => false);
    if (!available) continue;
    await stream.click();
    return stream;
  }
  throw new Error("Test Contour has no named Codex Stream");
}

function playwrightRuntime(automationRoot) {
  const require = createRequire(path.join(automationRoot, "package.json"));
  return require("playwright-core");
}

async function verifySameTabLocalAccess(browser, protectedUrl, timeoutMs) {
  const target = new URL(protectedUrl);
  const accessHash = target.hash;
  if (!/^#access=[A-Za-z0-9_-]{43,128}$/u.test(accessHash)) {
    throw new Error("Test Contour URL has no protected local access secret");
  }
  target.hostname = target.hostname === "localhost" ? "127.0.0.1" : "localhost";
  target.hash = "";
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator(".browser-auth[data-browser-auth]")
      .waitFor({ state: "visible", timeout: timeoutMs });
    await page.evaluate((hash) => { window.location.hash = hash; }, accessHash);
    await page.waitForFunction(
      () => !window.location.hash.startsWith("#access="),
      null,
      { timeout: timeoutMs },
    );
    await page.locator("[data-workspace]").waitFor({ state: "visible", timeout: timeoutMs });
    if (page.url().includes("#access=")) {
      throw new Error("Test Contour kept the local access secret in the address bar");
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator("[data-workspace]").waitFor({ state: "visible", timeout: timeoutMs });
    if (await page.locator(".browser-auth[data-browser-auth]").isVisible()) {
      throw new Error("Test Contour lost the local session after a browser reload");
    }
  } finally {
    await page.close();
  }
}

export async function runTestContourUiSmoke({
  url,
  automationRoot,
  artifactsDirectory,
  withAgent = true,
  model = "",
  probeResponse = TEST_CONTOUR_PROBE_RESPONSE,

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
    await verifySameTabLocalAccess(browser, url, timeoutMs);
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
      const selectedStream = await selectTestContourCodexStream(page, timeoutMs);
      await selectTestContourModel(page, model, timeoutMs);
      const previousUrl = page.url();
      await selectedStream.click({ button: "right" });
      const continueInCodex = page.locator(
        '[data-stream-menu-action="continue-provider"][data-provider="codex"]',
      );
      await continueInCodex.waitFor({ state: "visible", timeout: timeoutMs });
      await continueInCodex.evaluate((button) => button.click());
      await page.waitForFunction((previous) => (
        window.location.href !== previous && window.location.hash.includes("/chat/codex/")
      ), previousUrl, { timeout: timeoutMs });
      const input = page.locator("[data-composer-input]");
      await input.waitFor({ state: "visible", timeout: timeoutMs });
      await input.fill(TEST_CONTOUR_PROBE);
      await page.locator("[data-composer-send]").click();
      const response = page.locator(".msg-agent .msg-body")
        .filter({ hasText: exactTestContourResponsePattern(probeResponse) })
        .last();
      await response.waitFor({ state: "visible", timeout: timeoutMs });
      const responseText = (await response.innerText()).trim();
      if (responseText !== probeResponse) {
        throw new Error(`Unexpected Test Contour response: ${JSON.stringify(responseText)}`);
      }
    }

    const screenshot = path.join(artifactsDirectory, "ui-smoke.png");
    await page.screenshot({ path: screenshot, fullPage: false });
    if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`);
    return { title, screenshot, withAgent, sameTabAuth: true, errors: [] };
  } finally {
    await browser.close();
  }
}
