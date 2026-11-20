import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = new URL("../../assets/web-app/", import.meta.url);
const { loadThemeRegistry, renderThemeHtml } = createRequire(import.meta.url)("../../theme-registry.cjs");
const registry = loadThemeRegistry(fileURLToPath(ROOT));
const TAB = '.stream-tab[data-stream-tab-id="stream-0"]';
const RAIL = '.activity-stream-item[data-activity-task-id="task-0"]';


async function frames(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function setting(page, key, value) {
  await page.evaluate((detail) => document.dispatchEvent(new CustomEvent("agenthub:stream-view-settings-change", { detail })), { key, value });
  await frames(page);
}

async function publish(page, { tick = 0, running = true, unread = false, revision = 0 } = {}) {
  await page.evaluate(({ tick, running, unread, revision }) => {
    window.AgentHub.setWorkspaces([{ id: "workspace-0", name: "Workspace", settings: {} }], ["workspace:workspace-0", "notes"]);
    window.AgentHub.setTasks([0, 1].map((index) => ({
      id: `task-${index}`, provider: "codex", agentLabel: "Codex",
      workspaceId: "workspace-0", workspaceName: "Workspace", streamId: `stream-${index}`,
      streamName: index ? "Idle" : "Active", streamOrdinal: index + 1, selected: index === 0,
      status: index || !running ? "ready" : "running", running: index === 0 && running,
      unread: index === 0 && unread, openQuestion: index === 0 && unread,
      streamSettings: {}, progressStage: `stage-${tick}`,
      lastActivity: new Date().toISOString(),
      latestFinal: index === 0 && revision ? { provider: "codex", threadId: "thread-0", turnId: "turn-0", revision } : null,
    })));
  }, { tick, running, unread, revision });
  await frames(page);
}

async function open(page) {
  const snapshot = { apiVersion: 3, server: { status: "online" }, tasks: [], workspaces: [],
    archivedWorkspaces: [], boardTasks: [], boardLayout: { columnOrder: [] }, deferredInputs: [],
    messageReceipts: [], pendingApprovals: [], settings: { provider: "codex", models: [],
      modelOptionsByProvider: {}, reasoningOptions: [], reasoningOptionsByProvider: {}, modeOptions: [],
      quickMessages: { global: [], workspaces: {}, streams: {} } } };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/") {
      const html = renderThemeHtml(await readFile(new URL("index.html", ROOT), "utf8"), registry)
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/(?:browser-device-auth|hub-client)\.js" defer><\/script>/gu, "");
      return route.fulfill({ contentType: "text/html", body: html });
    }
    if (url.pathname === "/api/snapshot" || url.pathname === "/api/control") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(url.pathname.endsWith("control") ? { ok: true, result: snapshot } : snapshot) });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (relative.split("/").some((part) => !part || part === "." || part === "..")) return route.fulfill({ status: 404 });
    try {
      const type = relative.endsWith(".css") ? "text/css" : /\.(?:m?js)$/u.test(relative) ? "text/javascript" : relative.endsWith(".svg") ? "image/svg+xml" : relative.endsWith(".png") ? "image/png" : "application/octet-stream";
      return route.fulfill({ contentType: type, body: await readFile(new URL(relative, ROOT)) });
    } catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto("https://agent-hub.test/");
  await page.waitForFunction(() => typeof window.AgentHub === "object");
  await page.locator("[data-theme-select]").selectOption("cauldron", { force: true });
  // Text clocks are not part of the status paint oracle.
  await page.addStyleTag({ content: ".task-time, .provider-dot { visibility: hidden !important; }" });
  await publish(page);
}

async function launch() {
  const { chromium } = await import("playwright");
  return chromium.launch(process.platform === "win32"
    ? { executablePath: join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"), headless: true }
    : { headless: true });
}

async function paintChange(page, before, after) {
  return page.evaluate(async (encoded) => {
    const images = await Promise.all(encoded.map(async (value) => createImageBitmap(await (await fetch(`data:image/png;base64,${value}`)).blob())));
    const [image] = images;
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    const data = images.map((value) => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(value, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; });
    let changed = 0;
    // Inspect the interior, not a moving sliver outside the ceramic frame.
    for (let y = 8; y < image.height - 8; y += 1) for (let x = 8; x < image.width - 8; x += 1) {
      const i = (y * image.width + x) * 4;
      if (Math.max(...[0, 1, 2].map((channel) => Math.abs(data[0][i + channel] - data[1][i + channel]))) > 8) changed += 1;
    }
    for (const value of images) value.close();
    return changed;
  }, [before.toString("base64"), after.toString("base64")]);
}

async function evidence(name, bytes) {
  const directory = process.env.AGENT_HUB_TEST_EVIDENCE_DIR;
  if (directory) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, name), bytes); }
}

test("Ready strike remains visible on every theme", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await open(page);
    await setting(page, "streamStatusEffect", "static");
    await publish(page, { running: true, unread: true, revision: 1 });
    for (const theme of registry.themes) {
      await page.locator("[data-theme-select]").selectOption(theme.id, { force: true });
      await frames(page);
      const card = page.locator(RAIL);
      for (const selector of [TAB, RAIL]) {
        const target = page.locator(selector);
        const clearance = await target.evaluate(node => {
          const line = node.querySelector(".stream-ready-strike").getBoundingClientRect();
          const title = node.querySelector(".stream-tab-title");
          const time = node.querySelector(".task-time");
          return {
            question: getComputedStyle(title, "::before").content,
            gap: line.top - Math.max(title.getBoundingClientRect().bottom, time.getBoundingClientRect().bottom),
          };
        });
        assert.equal(clearance.question, '"?"');
        assert.ok(clearance.gap >= 2, `${theme.id}/${selector}: ready line clearance ${clearance.gap}px`);
      }
      const strike = card.locator(".stream-ready-strike");
      const geometry = await card.boundingBox();
      const visible = await card.screenshot();
      await strike.evaluate(node => { node.style.visibility = "hidden"; });
      const hidden = await card.screenshot();
      await strike.evaluate(node => { node.style.visibility = ""; });
      assert.ok(await paintChange(page, visible, hidden) > 6, theme.id);
      assert.deepEqual(await card.boundingBox(), geometry);
      await evidence(theme.id + "-ready.png", visible);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("Cauldron: rail keeps node/finite-final identity and idle/reduced-motion rules", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } }); await open(page);
    await page.evaluate(() => { document.documentElement.dataset.streamStatusEffect = "dynamic"; window.keptRail = document.querySelector('.activity-stream-item[data-activity-task-id="task-0"]'); });
    await frames(page);
    const initial = await page.locator(RAIL).evaluate((node) => Number(node.getAnimations({ subtree: true })[0].currentTime));
    for (let tick = 1; tick <= 3; tick += 1) await publish(page, { tick });
    await page.waitForFunction(({ selector, initial }) => Number(document.querySelector(selector).getAnimations({ subtree: true })[0]?.currentTime) > initial + 100, { selector: RAIL, initial });
    assert.equal(await page.locator(RAIL).evaluate((node) => node === window.keptRail), true);
    assert.equal(await page.locator(TAB).getAttribute("data-running"), "");
    assert.equal(await page.locator('.stream-tab[data-stream-tab-id="stream-1"]').getAttribute("data-running"), null);
    assert.equal(await page.locator('.activity-stream-item[data-activity-task-id="task-1"][data-running]').count(), 0);
    await publish(page, { tick: 4, running: false, unread: true, revision: 1 });
    await page.waitForFunction((selector) => document.querySelector(selector).getAnimations({ subtree: true }).length > 0, RAIL);
    await page.waitForFunction((selector) => Number(document.querySelector(selector).getAnimations({ subtree: true })[0]?.currentTime) > 250, RAIL);
    const arrivalImage = await page.locator(RAIL).screenshot({ animations: "allow" });
    await evidence("finite-arrival.png", arrivalImage);
    const finalTime = await page.locator(RAIL).evaluate((node) => Number(node.getAnimations({ subtree: true })[0].currentTime));
    await publish(page, { tick: 5, running: false, unread: true, revision: 1 });
    assert.equal(await page.locator(RAIL).evaluate((node) => node === window.keptRail), true);
    await page.waitForFunction(({ selector, finalTime }) => Number(document.querySelector(selector).getAnimations({ subtree: true })[0]?.currentTime) > finalTime + 100, { selector: RAIL, finalTime });
    await page.waitForFunction((selector) => document.querySelector(selector).getAnimations({ subtree: true }).every((a) => a.playState === "finished"), RAIL, { timeout: 5000 });
    await publish(page, { tick: 6, running: false, unread: true, revision: 1 });
    assert.equal(await page.locator(RAIL).evaluate((node) => node.getAnimations({ subtree: true }).length), 0, "same completed final must not replay");
    await publish(page, { tick: 7, running: false, unread: true, revision: 2 });
    assert.ok(await page.locator(RAIL).evaluate((node) => node.getAnimations({ subtree: true }).some((a) => a.playState === "running")));
    await publish(page, { tick: 8, running: false, unread: false, revision: 2 });
    assert.equal(await page.locator(RAIL).evaluate((node) => node.getAnimations({ subtree: true }).length), 0);
    const readImage = await page.locator(RAIL).screenshot({ animations: "allow" });
    assert.ok(await paintChange(page, readImage, arrivalImage) > 6, "finite arrival must be visible inside the frame");
    await evidence("read.png", readImage);
    await page.emulateMedia({ reducedMotion: "reduce" }); await publish(page, { tick: 9 });
    assert.equal(await page.locator(RAIL).evaluate((node) => node.getAnimations({ subtree: true }).length), 0);
    await page.locator(RAIL).click();
    assert.equal(await page.locator(RAIL).getAttribute("aria-pressed"), "true", "status paint must leave the original button clickable");
  } finally { await browser.close(); }
});
