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

async function publish(page, { tick = 0, running = true, unread = false, revision = 0, interstreamCompaction = false, interstreamRun = false } = {}) {
  await page.evaluate(({ tick, running, unread, revision, interstreamCompaction, interstreamRun }) => {
    window.AgentHub.setWorkspaces([{ id: "workspace-0", name: "Workspace", settings: {} }], ["workspace:workspace-0", "notes"]);
    window.AgentHub.setTasks([0, 1].map((index) => ({
      id: `task-${index}`, provider: "codex", agentLabel: "Codex",
      workspaceId: "workspace-0", workspaceName: "Workspace", streamId: `stream-${index}`,
      streamName: index ? "Idle" : "Active", streamOrdinal: index + 1, selected: index === 0,
      status: index || !running ? "ready" : "running", running: index === 0 && running,
      unread: index === 0 && unread, openQuestion: index === 0 && unread,
      interstreamRun: index === 0 && interstreamRun,
      streamSettings: {}, progressStage: `stage-${tick}`,
      lastActivity: new Date().toISOString(),
      context: index === 0 && interstreamCompaction ? { compaction: { status: "running" } } : undefined,
      latestFinal: index === 0 && revision ? { provider: "codex", threadId: "thread-0", turnId: "turn-0", revision, interstreamOnly: interstreamCompaction } : null,
    })));
  }, { tick, running, unread, revision, interstreamCompaction, interstreamRun });
  await frames(page);
}

async function open(page) {
  const nonce = "dHJhaWwtdGVzdA==";
  const snapshot = { apiVersion: 3, server: { status: "online" }, tasks: [], workspaces: [],
    archivedWorkspaces: [], boardTasks: [], boardLayout: { columnOrder: [] }, deferredInputs: [],
    messageReceipts: [], pendingApprovals: [], settings: { provider: "codex", models: [],
      modelOptionsByProvider: {}, reasoningOptions: [], reasoningOptionsByProvider: {}, modeOptions: [],
      quickMessages: { global: [], workspaces: {}, streams: {} } } };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/") {
      const html = renderThemeHtml(await readFile(new URL("index.html", ROOT), "utf8"), registry, { nonce })
        .replace("</head>", `<style nonce="${nonce}">.task-time, .provider-dot { visibility: hidden !important; }</style></head>`)
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/(?:browser-device-auth|hub-client)\.js" defer><\/script>/gu, "");
      return route.fulfill({ contentType: "text/html", body: html,
        headers: { "Content-Security-Policy": `style-src 'self' 'nonce-${nonce}'` } });
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
  await publish(page);
}

async function launch() {
  const { chromium } = await import("playwright");
  return chromium.launch(process.platform === "win32"
    ? { executablePath: join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"), headless: true }
    : { headless: true });
}

async function paintChange(page, before, after, { inset = 8, minBrightContrast = 0 } = {}) {
  return page.evaluate(async ({ encoded, inset, minBrightContrast }) => {
    const images = await Promise.all(encoded.map(async (value) => createImageBitmap(await (await fetch(`data:image/png;base64,${value}`)).blob())));
    const [image] = images;
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    const data = images.map((value) => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(value, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; });
    let changed = 0;
    function luminance(pixels, offset) {
      const linear = channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      return [0.2126, 0.7152, 0.0722].reduce((sum, weight, k) => sum + weight * linear(pixels[offset + k] / 255), 0);
    }
    for (let y = inset; y < image.height - inset; y += 1) for (let x = inset; x < image.width - inset; x += 1) {
      const i = (y * image.width + x) * 4;
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(data[0][i + channel] - data[1][i + channel]))) <= 8) continue;
      if (!minBrightContrast || (luminance(data[0], i) + .05) / (luminance(data[1], i) + .05) >= minBrightContrast) changed += 1;
    }
    for (const value of images) value.close();
    return changed;
  }, { encoded: [before.toString("base64"), after.toString("base64")], inset, minBrightContrast });
}

async function evidence(name, bytes) {
  const directory = process.env.AGENT_HUB_TEST_EVIDENCE_DIR;
  if (directory) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, name), bytes); }
}

test("Cauldron: solid and dotted paths follow the painted tile through its corner", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await open(page);
    for (const selector of [TAB, RAIL]) {
      const card = page.locator(selector);
      for (const dotted of [false, true]) {
        await card.evaluate((node, dotted) => node.toggleAttribute("data-interstream-run", dotted), dotted);
        await frames(page);
        const distances = await card.evaluate(node => {
          const tile = node.matches(".activity-stream-item") ? node : node.querySelector(".stream-tab-card");
          const box = tile.getBoundingClientRect();
          const style = getComputedStyle(tile);
          const rim = getComputedStyle(tile, "::after");
          const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(rim.right);
          const top = box.top + parseFloat(style.borderTopWidth) + parseFloat(rim.top);
          // Sample the center of the grey band in tile-frame.svg's 16-unit corner slice.
          const scale = parseFloat(rim.borderImageWidth) / 16;
          const targets = [[18, 4.5], [7.5, 7.5], [4.5, 18]]
            .map(([x, y]) => ({ x: right - x * scale, y: top + y * scale }));
          const path = node.querySelector(".stream-frame-outline");
          const matrix = path.ownerSVGElement.getScreenCTM().multiply(path.transform.baseVal.consolidate().matrix);
          const length = path.getTotalLength();
          const nearest = targets.map(() => Infinity);
          for (let offset = 0; offset < length; offset += .25) {
            const sample = path.getPointAtLength(offset).matrixTransform(matrix);
            targets.forEach(({ x, y }, index) => {
              nearest[index] = Math.min(nearest[index], Math.hypot(sample.x - x, sample.y - y));
            });
          }
          return nearest;
        });
        assert.ok(distances.every(value => value < .6), selector + " tile-edge distances " + distances);
      }
    }
  } finally { await browser.close(); }
});

test("Meadow: dotted ready and compaction tracks contrast with a sunlit background", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await open(page);
    await page.locator("[data-theme-select]").selectOption("meadow", { force: true });
    await setting(page, "streamStatusEffect", "static");
    await publish(page, { unread: true, revision: 1, interstreamCompaction: true });
    const card = page.locator(RAIL);
    // Use one bright field so a dark patch in the photograph cannot mask a regression.
    await card.locator(".stream-tab-card").evaluate(node => node.style.setProperty("background", "#d7c568", "important"));
    for (const selector of [".stream-ready-strike", ".stream-maintenance-track"]) {
      const track = card.locator(selector);
      const visible = await card.screenshot();
      await track.evaluate(node => node.style.visibility = "hidden");
      const background = await card.screenshot();
      await track.evaluate(node => node.style.visibility = "");
      assert.ok(await paintChange(page, visible, background, { inset: 3, minBrightContrast: 3 }) > 12, selector);
    }
  } finally { await browser.close(); }
});

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
      const eyes = await page.locator(".activity-read-button svg").evaluateAll(nodes =>
        nodes.map(node => getComputedStyle(node.querySelector("path")).fill));
      assert.equal(eyes.length, 2);
      const opaque = await page.locator(".activity-read-button").evaluateAll(buttons => {
        const ctx = new OffscreenCanvas(1, 1).getContext("2d");
        return buttons.every(button => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = getComputedStyle(button).backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
          return ctx.getImageData(0, 0, 1, 1).data[3] === 255;
        });
      });
      assert.ok(opaque, theme.id + ": opaque read button backgrounds");
      for (const selector of [TAB, RAIL]) {
        const target = page.locator(selector);
        const clearance = await target.evaluate(node => {
          const strike = node.querySelector(".stream-ready-strike");
          const line = strike.getBoundingClientRect();
          const probe = document.createElement("span");
          probe.style.color = "var(--accent)";
          node.append(probe);
          const accent = getComputedStyle(probe).color;
          probe.remove();
          const title = node.querySelector(".stream-tab-title");
          const time = node.querySelector(".task-time");
          return {
            accent,
            readyColor: getComputedStyle(strike).stroke,
            maintenanceColor: getComputedStyle(node.querySelector(".stream-maintenance-track")).stroke,
            question: getComputedStyle(title, "::before").content,
            gap: line.top - Math.max(title.getBoundingClientRect().bottom, time.getBoundingClientRect().bottom),
          };
        });
        assert.equal(clearance.question, '"?"');
        assert.deepEqual(eyes, [clearance.accent, clearance.accent], theme.id + ": read buttons");
        assert.equal(clearance.readyColor, clearance.accent, `${theme.id}/${selector}: ready color`);
        assert.equal(clearance.maintenanceColor, clearance.accent, `${theme.id}/${selector}: maintenance color`);
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

test("The head leads a fading trail and the lower ready line fades at both ends", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await open(page);
    await page.locator("[data-theme-select]").selectOption("nexus", { force: true });
    await setting(page, "streamStatusEffect", "static");
    await publish(page, { running: true, unread: true, revision: 1 });
    const card = page.locator('.task-workspace-item[data-running]').first();
    const probes = await card.evaluate(node => {
      const layer = node.querySelector(".stream-effect-layer");
      const frame = node.getBoundingClientRect();
      const line = node.querySelector(".stream-ready-strike").getBoundingClientRect();
      const path = node.querySelector(".stream-frame-outline");
      const matrix = layer.getScreenCTM().multiply(path.transform.baseVal.consolidate().matrix);
      const trail = [.025, .15, .28].map(fraction => {
        const p = path.getPointAtLength(path.getTotalLength() * fraction).matrixTransform(matrix);
        return [p.x - frame.left, p.y - frame.top];
      });
      const ready = [.04, .5, .96].map(fraction => [line.left + line.width * fraction - frame.left, line.top - frame.top]);
      return [...trail, ...ready];
    });
    const painted = await card.screenshot();
    await card.locator(".stream-effect-layer").evaluate(node => { node.style.visibility = "hidden"; });
    const background = await card.screenshot();
    const samples = await page.evaluate(async ({ pngs, probes }) => {
      const rasters = await Promise.all(pngs.map(async png => {
        const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + png)).blob());
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx;
      }));
      return probes.map(([x, y]) => {
        const [a, b] = rasters.map(ctx => ctx.getImageData(Math.round(x) - 1, Math.round(y) - 1, 3, 3).data);
        return a.reduce((max, channel, i) => i % 4 === 3 ? max : Math.max(max, Math.abs(channel - b[i])), 0);
      });
    }, { pngs: [painted, background].map(bytes => bytes.toString("base64")), probes });
    const [tail, body, head, left, center, right] = samples;
    assert.ok(tail < body && body < head, `trail intensity: ${samples}`);
    assert.ok(center > 2 * Math.max(left, right) && center > 10, `ready intensity: ${samples}`);
  } finally { await browser.close(); }
});

test("Inter-stream dots stay separated through a full lap under the server style policy", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    await open(page);
    await page.locator("[data-theme-select]").selectOption("nexus", { force: true });
    await setting(page, "streamStatusEffect", "dynamic");
    await publish(page, { interstreamRun: true });
    for (const selector of [TAB, RAIL]) {
      const card = page.locator(selector);
      for (const time of [0, 250, 500, 750, 1000, 1250, 1500, 1750]) {
        const offsets = await card.evaluate((node, time) => {
          const track = node.querySelector(".stream-run-track");
          const [animation] = track.getAnimations();
          animation.pause();
          animation.currentTime = time;
          return [...track.querySelectorAll(".stream-run-dot")].map(dot =>
            parseFloat(getComputedStyle(dot).strokeDashoffset));
        }, time);
        assert.equal(new Set(offsets).size, 6, selector + " at " + time + " ms: " + offsets);
      }
    }
  } finally { await browser.close(); }
});
