import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const ownerSource = await readFile(new URL("../../assets/web-app/file-transfer-owner.js", import.meta.url), "utf8");
const ownerCss = await readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8");
const appHtml = await readFile(new URL("../../assets/web-app/index.html", import.meta.url), "utf8");
const recipientHtml = await readFile(new URL("../../assets/web-app/file-transfer.html", import.meta.url), "utf8");
const recipientSource = await readFile(new URL("../../assets/web-app/file-transfer-recipient.js", import.meta.url), "utf8");
const recipientCss = await readFile(new URL("../../assets/web-app/file-transfer-recipient.css", import.meta.url), "utf8");
const capability = "#v1.transfer-v1.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee." + "s".repeat(43);
const captureDirectory = String(process.env.AGENT_HUB_TRANSFER_CAPTURE_DIR ?? "").trim();
async function capture(page, name) {
  if (!captureDirectory) return;
  await mkdir(captureDirectory, { recursive: true });
  await page.screenshot({ path: `${captureDirectory}/${name}.png`, fullPage: true });
}

async function withBrowser(run) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try { await run(browser); } finally { await browser.close(); }
}

async function assertOwnerDialogGeometry(page, { bodyControl, expectScrollable = false } = {}) {
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector(".file-transfer-owner-dialog");
    const panel = dialog.querySelector(".file-transfer-owner-panel");
    const body = dialog.querySelector(".file-transfer-owner-body");
    const footer = dialog.querySelector(".file-transfer-owner-actions");
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { top: value.top, right: value.right, bottom: value.bottom, left: value.left };
    };
    return {
      dialog: rect(dialog),
      panel: rect(panel),
      footer: rect(footer),
      actions: [...footer.querySelectorAll("button")].map(rect),
      body: {
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        overflowY: getComputedStyle(body).overflowY,
      },
      viewportHeight,
      viewportWidth,
    };
  });
  assert.ok(geometry.footer.bottom <= Math.min(geometry.dialog.bottom, geometry.viewportHeight) + 1, JSON.stringify(geometry));
  assert.ok(geometry.dialog.top >= -1 && geometry.panel.top >= -1, JSON.stringify(geometry));
  assert.ok(geometry.footer.left >= Math.max(0, geometry.dialog.left) - 1, JSON.stringify(geometry));
  assert.ok(geometry.footer.right <= Math.min(geometry.dialog.right, geometry.viewportWidth) + 1, JSON.stringify(geometry));
  assert.ok(geometry.actions.length > 0);
  for (const action of geometry.actions) {
    assert.ok(action.top >= geometry.footer.top - 1 && action.bottom <= geometry.footer.bottom + 1, JSON.stringify(geometry));
    assert.ok(action.top >= 0 && action.bottom <= geometry.viewportHeight + 1, JSON.stringify(geometry));
  }
  assert.match(geometry.body.overflowY, /auto|scroll/u);
  assert.ok(geometry.body.scrollHeight >= geometry.body.clientHeight);
  if (expectScrollable) assert.ok(geometry.body.scrollHeight > geometry.body.clientHeight, JSON.stringify(geometry));
  if (geometry.body.scrollHeight > geometry.body.clientHeight) {
    const scrollTop = await page.evaluate(() => {
      const body = document.querySelector(".file-transfer-owner-body");
      body.scrollTop = body.scrollHeight;
      return body.scrollTop;
    });
    assert.ok(scrollTop > 0);
  }
  if (bodyControl) {
    await page.locator(bodyControl).focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.querySelector(".file-transfer-owner-actions").contains(document.activeElement)), true);
    const focusedGeometry = await page.evaluate(() => {
      const dialog = document.querySelector(".file-transfer-owner-dialog");
      const footer = document.querySelector(".file-transfer-owner-actions");
      const dialogRect = dialog.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      return { dialogTop: dialogRect.top, footerBottom: footerRect.bottom, scrollY: window.scrollY,
        dialogScrollTop: dialog.scrollTop, viewportHeight: window.visualViewport?.height ?? window.innerHeight };
    });
    assert.ok(focusedGeometry.dialogTop >= -1, JSON.stringify(focusedGeometry));
    assert.ok(focusedGeometry.footerBottom <= focusedGeometry.viewportHeight + 1, JSON.stringify(focusedGeometry));
    assert.equal(focusedGeometry.scrollY, 0);
    assert.equal(focusedGeometry.dialogScrollTop, 0, JSON.stringify(focusedGeometry));
  }
  return geometry;
}

async function assertOwnerState(page, expectedHeading) {
  assert.deepEqual(await page.evaluate(() => {
    const dialog = document.querySelector(".file-transfer-owner-dialog");
    const body = dialog.querySelector(".file-transfer-owner-body");
    const sections = body.querySelectorAll(":scope > .file-transfer-owner-state");
    const headings = body.querySelectorAll(":scope > .file-transfer-owner-state > h3");
    const section = sections[0];
    const heading = headings[0];
    return {
      chips: dialog.querySelectorAll(".file-transfer-owner-chip").length,
      sections: sections.length,
      headings: headings.length,
      heading: heading?.textContent,
      labelledBy: section?.getAttribute("aria-labelledby"),
      headingId: heading?.id,
      sectionPosition: section ? getComputedStyle(section).position : null,
      headingPosition: heading ? getComputedStyle(heading).position : null,
    };
  }), {
    chips: 0,
    sections: 1,
    headings: 1,
    heading: expectedHeading,
    labelledBy: "file-transfer-owner-state-title",
    headingId: "file-transfer-owner-state-title",
    sectionPosition: "static",
    headingPosition: "static",
  });
}

test("owner dialog performs no publication before explicit create and renders a recoverable ready state", { timeout: 30_000 }, async (t) => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await page.setContent(`<!doctype html><html data-theme="orbit"><head><style>${ownerCss}</style></head><body><button id="open">Open</button></body></html>`);
    await page.addScriptTag({ content: ownerSource });
    await page.evaluate(() => {
      const state = {
        artifact: null,
        share: null,
        file: { name: "Очень-длинное-имя-данных-🧪-2026.bin", size: 700 * 1024 * 1024 },
        ttlOptions: [3_600_000, 86_400_000],
      };
      window.__calls = [];
      window.AgentHubFileTransferOwner.configure(async (action, body) => {
        window.__calls.push([action, body]);
        if (action === "status") return structuredClone(state);
        if (action === "prepare") {
          state.artifact = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "ready", preparedBytes: state.file.size, size: state.file.size };
          return { artifact: { ...state.artifact, state: "preparing", preparedBytes: 0 } };
        }
        if (action === "create") {
          state.share = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", artifactId: state.artifact.id,
            state: "ready", name: state.file.name, size: state.file.size, sha256: "a".repeat(64),
            createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, claimedAt: null, completedAt: null,
            bytesServed: 0, firstByteAt: null, url: "https://downloads.example.test/transfer/#secret" };
          return { share: state.share };
        }
        throw new Error("unexpected action");
      });
      return window.AgentHubFileTransferOwner.open({ path: "D:/work/file.bin", trigger: document.querySelector("#open") });
    });
    await page.getByRole("heading", { name: "Защищённая внешняя ссылка" }).waitFor();
    assert.deepEqual(await page.evaluate(() => ({
      activeId: document.activeElement?.id,
      outline: getComputedStyle(document.querySelector("#file-transfer-owner-title")).outlineStyle,
    })), { activeId: "file-transfer-owner-title", outline: "none" });
    await capture(page, "owner-mobile-create-390-dark");
    await page.setViewportSize({ width: 320, height: 640 });
    await assertOwnerDialogGeometry(page, { bodyControl: "[data-transfer-ttl]" });
    await page.evaluate(() => {
      document.querySelector(".file-transfer-owner-body").scrollTop = 0;
      document.querySelector("#file-transfer-owner-title").focus({ preventScroll: true });
    });
    await capture(page, "owner-mobile-create-320-dark");
    await page.setViewportSize({ width: 390, height: 720 });
    assert.equal(await page.getByText(/Первый получатель/u).count(), 1);
    assert.deepEqual((await page.evaluate(() => window.__calls)).map(([action]) => action), ["status"]);
    await page.getByRole("button", { name: "Создать ссылку" }).click();
    try { await page.getByRole("button", { name: "Копировать ссылку" }).waitFor({ timeout: 5_000 }); }
    catch (error) {
      t.diagnostic(JSON.stringify(await page.evaluate(() => ({ calls: window.__calls, body: document.body.innerText }))));
      throw error;
    }
    assert.deepEqual((await page.evaluate(() => window.__calls)).map(([action]) => action), ["status", "prepare", "status", "create"]);
    assert.equal(await page.getByRole("heading", { name: "Ссылка готова" }).count(), 1);
    assert.equal(await page.locator("input[data-transfer-url]").inputValue(), "https://downloads.example.test/transfer/#secret");
    await assertOwnerState(page, "Ссылка готова");
    await capture(page, "owner-mobile-ready-390-dark");
    await page.setViewportSize({ width: 320, height: 640 });
    await assertOwnerDialogGeometry(page, { bodyControl: "[data-transfer-url]" });
    await page.evaluate(() => {
      document.querySelector(".file-transfer-owner-body").scrollTop = 0;
      document.querySelector("#file-transfer-owner-title").focus({ preventScroll: true });
    });
    await capture(page, "owner-mobile-ready-320-dark");
    await page.setViewportSize({ width: 390, height: 420 });
    await assertOwnerDialogGeometry(page, { bodyControl: "[data-transfer-url]", expectScrollable: true });
    await page.evaluate(() => {
      document.querySelector(".file-transfer-owner-body").scrollTop = 0;
      document.querySelector("#file-transfer-owner-title").focus({ preventScroll: true });
    });
    await capture(page, "owner-mobile-ready-short-height-390-dark");
    await page.evaluate(() => {
      const body = document.querySelector(".file-transfer-owner-body");
      body.scrollTop = body.scrollHeight;
    });
    await assertOwnerDialogGeometry(page, { expectScrollable: true });
    await capture(page, "owner-mobile-ready-short-height-scrolled-390-dark");
  });
});

test("resource entry captures use the production menu and keep the mobile overflow target reachable", {
  timeout: 30_000,
  skip: !captureDirectory,
}, async () => {
  const menuHtml = appHtml.match(/<div class="resource-context-menu"[\s\S]*?<\/div>/u)?.[0];
  assert.ok(menuHtml, "production resource context menu markup must exist");
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.setContent(`<!doctype html><html data-theme="orbit"><head><style>${ownerCss}</style></head><body>
      <main style="padding:48px;max-width:820px;margin:auto">
        <article class="msg" style="padding:24px"><div class="msg-head"><strong class="msg-author">Agent Hub</strong></div>
          <div class="msg-body"><p>Готовый файл Workspace</p><p data-resource-row style="display:flex;align-items:center;gap:8px">
            <a class="file-citation" href="#">Очень-длинное-имя-данных-🧪-2026.bin</a>
            <button type="button" class="local-resource-overflow" aria-label="Действия с файлом Очень-длинное-имя-данных-🧪-2026.bin">⋯</button>
          </p></div></article>${menuHtml}
      </main></body></html>`);
    const showMenu = async ({ x, y }) => page.evaluate(({ x, y }) => {
      const menu = document.querySelector("[data-resource-context-menu]");
      menu.querySelectorAll("[data-resource-action], [data-resource-action-divider]").forEach((item) => { item.hidden = false; });
      menu.querySelector('[data-resource-action="external-share"]').textContent = "Создать внешнюю ссылку…";
      menu.hidden = false;
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    }, { x, y });
    await showMenu({ x: 700, y: 220 });
    assert.equal(await page.locator('[data-resource-action-divider="external-share"]:visible').count(), 1);
    assert.equal(await page.getByRole("menuitem", { name: "Создать внешнюю ссылку…" }).count(), 1);
    await capture(page, "owner-entry-web-context-menu-1280-dark");

    await page.setViewportSize({ width: 390, height: 720 });
    await page.evaluate(() => { document.querySelector("[data-resource-context-menu]").hidden = true; });
    const overflow = page.getByRole("button", { name: /Действия с файлом/u });
    const overflowBox = await overflow.boundingBox();
    assert.ok(overflowBox && overflowBox.width >= 44 && overflowBox.height >= 44, JSON.stringify(overflowBox));
    await overflow.click();
    await showMenu({ x: 16, y: 245 });
    await capture(page, "owner-entry-mobile-overflow-menu-390-dark");
  });
});

async function recipientPage(browser, {
  webview = false, picker = true, claimFails = 0, inspectFails = false,
  claimTransportFailures = 0, claimCookieStored = false, claimHttpFailures = 0,
  claimHttpFailureStatus = 502,
  downloadFails = false, planDelayMs = 0, colorScheme = "light", width = 390,
} = {}) {
  const context = await browser.newContext({ viewport: { width, height: 760 }, colorScheme });
  await context.addInitScript(({ webview, picker }) => {
    if (webview) Object.defineProperty(navigator, "userAgent", { value: "VSCode WebView", configurable: true });
    if (picker) {
      window.__writes = [];
      window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write: async (part) => window.__writes.push([...part.data]),
        close: async () => { window.__closed = true; },
        abort: async () => { window.__aborted = true; },
      }) });
    } else Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  }, { webview, picker });
  const calls = [];
  const claimBodies = [];
  const claimSessions = new Set();
  let remainingClaimTransportFailures = claimTransportFailures;
  let remainingClaimHttpFailures = claimHttpFailures;
  const testSelector = "q".repeat(43);
  await context.route("https://downloads.example.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/transfer/" || url.pathname === "/transfer") {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: recipientHtml }); return;
    }
    if (url.pathname === "/transfer/app.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: recipientSource }); return;
    }
    if (url.pathname === "/transfer/styles.css") {
      await route.fulfill({ status: 200, contentType: "text/css", body: recipientCss }); return;
    }
    const action = url.pathname.split("/").at(-1);
    calls.push(action);
    if (action === "inspect") {
      await route.fulfill({ status: inspectFails ? 410 : 200, contentType: "application/json",
        body: inspectFails ? "{}" : JSON.stringify({ name: "700MB-🧪.bin", size: 4, expiresAt: Date.now() + 60_000 }) });
    } else if (action === "challenge") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ payload: JSON.stringify({ challengeId: "one" }) }) });
    } else if (action === "claim") {
      claimBodies.push(request.postDataJSON());
      claimSessions.add(JSON.stringify(request.postDataJSON()));
      if (remainingClaimTransportFailures > 0) {
        remainingClaimTransportFailures -= 1;
        if (claimCookieStored) await route.fulfill({ status: 200, contentType: "application/json",
          headers: { "Set-Cookie": `__Secure-agenthub_transfer_${testSelector}=opaque; Path=/transfer/api/session/${testSelector}/; Secure; HttpOnly; SameSite=Strict` },
          body: "{" });
        else await route.abort("connectionreset");
      } else if (remainingClaimHttpFailures > 0) {
        remainingClaimHttpFailures -= 1;
        await route.fulfill({ status: claimHttpFailureStatus, contentType: "application/json", body: "{}" });
      } else await route.fulfill({ status: claimFails || 200, contentType: "application/json",
        body: claimFails ? "{}" : JSON.stringify({ ok: true, session: testSelector }) });
    } else if (action === "plan") {
      if (planDelayMs) await new Promise((resolve) => setTimeout(resolve, planDelayMs));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ payload: JSON.stringify({
        path: `/transfer/api/session/${testSelector}/download`, start: 0, end: 3, etag: '"sha256:test"' }) }) });
    } else if (action === "download") {
      if (downloadFails) await route.abort("failed");
      else await route.fulfill({ status: 206, contentType: "application/octet-stream", body: Buffer.from("data") });
    } else await route.fulfill({ status: 410, contentType: "application/json", body: "{}" });
  });
  const page = await context.newPage();
  await page.goto(`https://downloads.example.test/transfer/${capability}`);
  return { context, page, calls, claimBodies, claimSessions };
}

test("recipient claims only after picker, local key setup and explicit Download", { timeout: 30_000 }, async () => {
  await withBrowser(async (browser) => {
    const { context, page, calls } = await recipientPage(browser);
    await page.getByRole("button", { name: "Скачать" }).waitFor();
    await capture(page, "recipient-mobile-ready-390-light");
    assert.deepEqual(calls, ["inspect"]);
    await page.getByRole("button", { name: "Скачать" }).click();
    await page.getByRole("heading", { name: "Файл сохранён" }).waitFor();
    assert.deepEqual(calls, ["inspect", "challenge", "claim", "plan", "download"]);
    assert.equal(await page.evaluate(() => window.__closed), true);
    assert.equal(await page.evaluate(() => location.hash), "");
    await capture(page, "recipient-mobile-completed-390-light");
    await context.close();
  });
});

test("recipient retries only the byte-identical claim after ambiguous transport, body or 5xx loss", { timeout: 60_000 }, async () => {
  await withBrowser(async (browser) => {
    for (const claimCookieStored of [false, true]) {
      const value = await recipientPage(browser, { claimTransportFailures: 1, claimCookieStored });
      await value.page.getByRole("button", { name: "Скачать" }).click();
      await value.page.getByRole("heading", { name: "Файл сохранён" }).waitFor();
      assert.equal(value.claimBodies.length, 2);
      assert.deepEqual(value.claimBodies[1], value.claimBodies[0]);
      assert.equal(await value.page.evaluate(() => window.__aborted === true), false);
      assert.equal(await value.page.evaluate(() => window.__closed), true);
      assert.equal(value.calls.filter((action) => action === "challenge").length, 1);
      assert.equal(value.claimSessions.size, 1);
      await value.context.close();
    }
    const proxyLoss = await recipientPage(browser, { claimHttpFailures: 1, claimHttpFailureStatus: 502 });
    await proxyLoss.page.getByRole("button", { name: "Скачать" }).click();
    await proxyLoss.page.getByRole("heading", { name: "Файл сохранён" }).waitFor();
    assert.equal(proxyLoss.claimBodies.length, 2);
    assert.deepEqual(proxyLoss.claimBodies[1], proxyLoss.claimBodies[0]);
    assert.equal(proxyLoss.claimSessions.size, 1, "proxy replacement must not create a second claim session");
    assert.equal(proxyLoss.calls.filter((action) => action === "challenge").length, 1);
    assert.equal(await proxyLoss.page.evaluate(() => window.__aborted === true), false);
    assert.equal(await proxyLoss.page.evaluate(() => window.__closed), true);
    await proxyLoss.context.close();

    const definite = await recipientPage(browser, { claimFails: 410 });
    await definite.page.getByRole("button", { name: "Скачать" }).click();
    await definite.page.getByRole("heading", { name: "Не удалось подтвердить начало загрузки" }).waitFor();
    assert.equal(definite.claimBodies.length, 1, "definite 4xx must not retry a claim");
    assert.equal(definite.calls.filter((action) => action === "challenge").length, 1);
    await definite.context.close();
  });
});

test("two recipient tabs keep distinct scoped sessions through interleaved resume", { timeout: 60_000 }, async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 760 } });
    await context.addInitScript(() => {
      window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write: async () => {}, close: async () => {}, abort: async () => {},
      }) });
    });
    const shares = [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secret: "a".repeat(43), selector: "m".repeat(43) },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", secret: "b".repeat(43), selector: "n".repeat(43) },
    ];
    const byId = new Map(shares.map((value) => [value.id, value]));
    const planWaiters = [];
    const cookieEvidence = [];
    const downloadAttempts = new Map();
    await context.route("https://downloads.example.test/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (["/transfer", "/transfer/"].includes(url.pathname)) {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: recipientHtml }); return;
      }
      if (url.pathname === "/transfer/app.js") {
        await route.fulfill({ status: 200, contentType: "text/javascript", body: recipientSource }); return;
      }
      if (url.pathname === "/transfer/styles.css") {
        await route.fulfill({ status: 200, contentType: "text/css", body: recipientCss }); return;
      }
      const action = url.pathname.split("/").at(-1);
      const body = request.postDataJSON();
      if (action === "inspect") {
        await route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ name: `${body.shareId}.bin`, size: 4, expiresAt: Date.now() + 60_000 }) });
      } else if (action === "challenge") {
        await route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ payload: JSON.stringify({ challengeId: body.shareId }) }) });
      } else if (action === "claim") {
        const current = byId.get(body.shareId);
        await route.fulfill({ status: 200, contentType: "application/json",
          headers: { "Set-Cookie": `__Secure-agenthub_transfer_${current.selector}=credential-${current.id}; Path=/transfer/api/session/${current.selector}/; Secure; HttpOnly; SameSite=Strict` },
          body: JSON.stringify({ ok: true, session: current.selector }) });
      } else if (action === "plan") {
        const selectorValue = url.pathname.split("/").at(-2);
        const headers = await request.allHeaders();
        cookieEvidence.push({ action, selector: selectorValue, cookie: headers.cookie ?? "" });
        planWaiters.push({ route, selector: selectorValue });
        if (planWaiters.length % 2 === 0) {
          for (const waiter of planWaiters.splice(0, 2)) await waiter.route.fulfill({ status: 200,
            contentType: "application/json", body: JSON.stringify({ payload: JSON.stringify({
              path: `/transfer/api/session/${waiter.selector}/download`, start: 0, end: 3, etag: '"sha256:test"',
            }) }) });
        }
      } else if (action === "download") {
        const selectorValue = url.pathname.split("/").at(-2);
        const headers = await request.allHeaders();
        cookieEvidence.push({ action, selector: selectorValue, cookie: headers.cookie ?? "" });
        const attempt = (downloadAttempts.get(selectorValue) ?? 0) + 1;
        downloadAttempts.set(selectorValue, attempt);
        if (attempt === 1) await route.abort("connectionreset");
        else await route.fulfill({ status: 206, contentType: "application/octet-stream", body: Buffer.from("data") });
      } else await route.fulfill({ status: 410, contentType: "application/json", body: "{}" });
    });
    const pages = await Promise.all(shares.map(async (share) => {
      const page = await context.newPage();
      await page.goto(`https://downloads.example.test/transfer/#v1.transfer-v1.${share.id}.${share.secret}`);
      await page.getByRole("button", { name: "Скачать" }).waitFor();
      return page;
    }));
    await Promise.all(pages.map((page) => page.getByRole("button", { name: "Скачать" }).click()));
    await Promise.all(pages.map((page) => page.getByRole("button", { name: "Продолжить загрузку" }).waitFor()));
    await Promise.all(pages.map((page) => page.getByRole("button", { name: "Продолжить загрузку" }).click()));
    await Promise.all(pages.map((page) => page.getByRole("heading", { name: "Файл сохранён" }).waitFor()));
    assert.deepEqual([...downloadAttempts.values()].sort(), [2, 2]);
    for (const evidence of cookieEvidence) {
      assert.match(evidence.cookie, new RegExp(`__Secure-agenthub_transfer_${evidence.selector}=`, "u"));
      const other = shares.find((share) => share.selector !== evidence.selector);
      assert.doesNotMatch(evidence.cookie, new RegExp(`__Secure-agenthub_transfer_${other.selector}=`, "u"));
    }
    await context.close();
  });
});

test("recipient surfaces fail closed for WebView, unsupported browser and ambiguous claim", { timeout: 60_000 }, async () => {
  await withBrowser(async (browser) => {
    const webview = await recipientPage(browser, { webview: true });
    await webview.page.getByRole("button", { name: "Копировать ссылку" }).waitFor();
    assert.deepEqual(webview.calls, []);
    assert.match(await webview.page.locator("body").innerText(), /откройте её во внешнем браузере/u);
    await capture(webview.page, "recipient-webview-handoff-390-light");
    await webview.context.close();

    const unsupported = await recipientPage(browser, { picker: false });
    await unsupported.page.getByRole("heading", { name: "Защищённая загрузка недоступна" }).waitFor();
    assert.match(await unsupported.page.locator("body").innerText(), /Ссылка не использована/u);
    assert.deepEqual(unsupported.calls, []);
    await capture(unsupported.page, "recipient-mobile-unsupported-390-light");
    await unsupported.context.close();

    const ambiguous = await recipientPage(browser, { claimFails: 500 });
    await ambiguous.page.getByRole("button", { name: "Скачать" }).click();
    await ambiguous.page.getByRole("heading", { name: "Не удалось подтвердить начало загрузки" }).waitFor();
    assert.match(await ambiguous.page.locator("body").innerText(), /Ссылка могла быть использована/u);
    assert.equal(await ambiguous.page.getByRole("button", { name: /Повтор/u }).count(), 0);
    await capture(ambiguous.page, "recipient-mobile-ambiguous-390-light");
    await ambiguous.context.close();
  });
});

test("owner production assets capture the complete authoritative state matrix", {
  timeout: 60_000,
  skip: !captureDirectory,
}, async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.setContent(`<!doctype html><html data-theme="orbit"><head><style>${ownerCss}</style></head><body><button id="open">Open</button></body></html>`);
    await page.addScriptTag({ content: ownerSource });
    await page.evaluate(() => {
      window.__snapshot = null;
      window.__statusFails = false;
      window.AgentHubFileTransferOwner.configure(async (action) => {
        if (window.__statusFails) throw new Error("offline");
        if (action === "status") return structuredClone(window.__snapshot);
        if (action === "revoke") return { share: { ...window.__snapshot.share, state: "revoked" } };
        throw new Error("unexpected action");
      });
    });
    const file = { name: "Очень-длинное-имя-данных-🧪-для-проверки-переноса-2026.bin", size: 700 * 1024 * 1024 };
    const artifact = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: file.name, size: file.size,
      sha256: "a".repeat(64), state: "ready", preparedBytes: file.size, expiresAt: Date.now() + 86_400_000 };
    const baseShare = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", artifactId: artifact.id,
      name: file.name, size: file.size, sha256: artifact.sha256, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000,
      claimedAt: Date.now() - 30_000, bytesServed: 240 * 1024 * 1024 };
    const cases = [
      ["owner-web-preparing-1280-dark", "Подготовка файла", { file, artifact: { ...artifact, state: "preparing", preparedBytes: 311 * 1024 * 1024 }, share: null }],
      ["owner-web-ready-1280-dark", "Ссылка готова", { file, artifact, share: { ...baseShare, state: "ready", url: "https://downloads.example.test/transfer/#v1.hidden-capability" } }],
      ["owner-web-claimed-1280-dark", "Ссылка использована", { file, artifact, share: { ...baseShare, state: "claimed" } }],
      ["owner-web-downloading-1280-dark", "Файл передаётся", { file, artifact, share: { ...baseShare, state: "downloading" } }],
      ["owner-web-completed-1280-dark", "Передача завершена", { file, artifact, share: { ...baseShare, state: "completed", completedAt: Date.now() } }],
      ["owner-web-expired-1280-dark", "Срок ссылки истёк", { file, artifact, share: { ...baseShare, state: "expired" } }],
      ["owner-web-revoked-1280-dark", "Ссылка отозвана", { file, artifact, share: { ...baseShare, state: "revoked" } }],
      ["owner-web-failed-1280-dark", "Ошибка передачи", { file, artifact, share: { ...baseShare, state: "failed" } }],
    ];
    for (const [name, heading, value] of cases) {
      await page.evaluate(async (snapshot) => {
        window.__snapshot = { ...snapshot, ttlOptions: [3_600_000, 86_400_000] };
        window.__statusFails = false;
        await window.AgentHubFileTransferOwner.open({ path: "D:/work/file.bin", trigger: document.querySelector("#open") });
      }, value);
      await assertOwnerState(page, heading);
      await capture(page, name);
      await page.evaluate(() => document.querySelector(".file-transfer-owner-dialog").close());
    }
    await page.evaluate(async (snapshot) => {
      window.__snapshot = { ...snapshot, ttlOptions: [3_600_000] };
      window.__statusFails = true;
      await window.AgentHubFileTransferOwner.open({ path: "D:/work/file.bin", trigger: document.querySelector("#open") });
    }, { file, artifact, share: null });
    await assertOwnerState(page, "Не удалось получить актуальный статус");
    await capture(page, "owner-web-unknown-1280-dark");
  });
});

test("recipient production assets capture responsive dark and recovery states", {
  timeout: 60_000,
  skip: !captureDirectory,
}, async () => {
  await withBrowser(async (browser) => {
    const dark = await recipientPage(browser, { colorScheme: "dark" });
    await dark.page.getByRole("button", { name: "Скачать" }).waitFor();
    await capture(dark.page, "recipient-mobile-ready-390-dark");
    await dark.context.close();

    const webview = await recipientPage(browser, { webview: true, width: 520 });
    await webview.page.getByRole("button", { name: "Копировать ссылку" }).waitFor();
    await capture(webview.page, "recipient-webview-handoff-520-light");
    await webview.context.close();

    const downloading = await recipientPage(browser, { planDelayMs: 2_000 });
    await downloading.page.getByRole("button", { name: "Скачать" }).click();
    await downloading.page.getByRole("heading", { name: "Загрузка файла" }).waitFor();
    await capture(downloading.page, "recipient-mobile-downloading-390-light");
    await downloading.context.close();

    const interrupted = await recipientPage(browser, { downloadFails: true });
    await interrupted.page.getByRole("button", { name: "Скачать" }).click();
    await interrupted.page.getByRole("button", { name: "Продолжить загрузку" }).waitFor();
    await capture(interrupted.page, "recipient-mobile-resume-390-light");
    await interrupted.context.close();

    const unavailable = await recipientPage(browser, { inspectFails: true });
    await unavailable.page.getByRole("heading", { name: "Ссылка недоступна" }).waitFor();
    await capture(unavailable.page, "recipient-mobile-unavailable-390-light");
    await unavailable.context.close();

    const keyLoss = await recipientPage(browser);
    await keyLoss.page.evaluate(() => sessionStorage.setItem("agenthub-transfer-last-claimed", "lost"));
    await keyLoss.page.goto("https://downloads.example.test/transfer/");
    await keyLoss.page.getByRole("heading", { name: "Продолжить загрузку нельзя" }).waitFor();
    await capture(keyLoss.page, "recipient-mobile-key-loss-390-light");
    await keyLoss.context.close();
  });
});
