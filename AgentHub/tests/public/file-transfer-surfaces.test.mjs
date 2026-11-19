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
async function capture(page, name, { fullPage = true } = {}) {
  if (!captureDirectory) return;
  await mkdir(captureDirectory, { recursive: true });
  await page.screenshot({ path: `${captureDirectory}/${name}.png`, fullPage });
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
        artifact: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "ready",
          preparedBytes: 700 * 1024 * 1024, size: 700 * 1024 * 1024 },
        share: null,
        file: { name: "Очень-длинное-имя-данных-🧪-2026.bin", size: 700 * 1024 * 1024 },
        ttlOptions: [3_600_000, 86_400_000],
      };
      window.__pendingPolls = 0;
      window.__calls = [];
      window.AgentHubFileTransferOwner.configure(async (action, body) => {
        window.__calls.push([action, body]);
        if (action === "status") {
          if (state.share?.state === "preparing") {
            window.__pendingPolls += 1;
            const preparedBytes = window.__pendingPolls * 128 * 1024 * 1024;
            if (window.__pendingPolls < 3) {
              state.artifact = { ...state.artifact, preparedBytes };
              state.share = { ...state.share, preparedBytes };
            } else {
              state.artifact = { ...state.artifact, state: "ready", preparedBytes: state.file.size };
              state.share = { ...state.share, state: "ready", preparedBytes: state.file.size, sha256: "a".repeat(64) };
            }
          }
          return structuredClone(state);
        }
        if (action === "prepare") {
          state.artifact = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "preparing", preparedBytes: 0, size: state.file.size };
          return { artifact: state.artifact };
        }
        if (action === "create") {
          state.share = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", artifactId: state.artifact.id,
            state: "preparing", name: state.file.name, size: state.file.size, sha256: null, preparedBytes: 0,
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
    await page.evaluate(() => {
      window.__semanticAnnouncements = [];
      const target = document.querySelector("[data-transfer-semantic-status]");
      new MutationObserver(() => window.__semanticAnnouncements.push(target.textContent)).observe(target, { childList: true });
    });
    await page.getByRole("button", { name: "Создать ссылку" }).click();
    try { await page.getByRole("button", { name: "Копировать ссылку" }).waitFor({ timeout: 5_000 }); }
    catch (error) {
      t.diagnostic(JSON.stringify(await page.evaluate(() => ({ calls: window.__calls, body: document.body.innerText }))));
      throw error;
    }
    assert.deepEqual((await page.evaluate(() => window.__calls)).map(([action]) => action), ["status", "prepare", "create"]);
    assert.equal(await page.getByRole("heading", { name: "Ссылка создана" }).count(), 1);
    assert.equal(await page.locator("input[data-transfer-url]").inputValue(), "https://downloads.example.test/transfer/#secret");
    assert.equal(await page.getByText(/Ссылку уже можно отправить/u).count(), 1);
    assert.equal(await page.locator(".file-transfer-owner-body").getAttribute("aria-live"), null);
    await page.locator("input[data-transfer-url]").focus();
    await assertOwnerState(page, "Ссылка создана");
    await page.getByRole("heading", { name: "Ссылка готова" }).waitFor({ timeout: 5_000 });
    assert.equal(await page.locator("input[data-transfer-url]").inputValue(), "https://downloads.example.test/transfer/#secret");
    assert.equal(await page.evaluate(() => document.activeElement?.matches("input[data-transfer-url]")), true,
      "ready projection must update the same link DOM without stealing focus");
    assert.deepEqual(await page.evaluate(() => window.__semanticAnnouncements), ["Ссылка создана", "Файл готов к скачиванию"],
      "progress repaints must not generate live-region announcements");
    assert.equal((await page.evaluate(() => window.__calls)).filter(([action]) => action === "status").length, 4);
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
  inspectSequence = null, inspectTransportFailures = 0,
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
  let remainingInspectTransportFailures = inspectTransportFailures;
  let inspectIndex = 0;
  let forcedInspectState = null;
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
      if (remainingInspectTransportFailures > 0) {
        remainingInspectTransportFailures -= 1;
        await route.abort("connectionreset");
      } else {
        const states = inspectSequence?.length ? inspectSequence : ["ready"];
        const state = forcedInspectState ?? states[Math.min(inspectIndex++, states.length - 1)];
        if (state === "transport-error") {
          await route.abort("connectionreset");
          return;
        }
        await route.fulfill({ status: inspectFails ? 410 : 200, contentType: "application/json",
          body: inspectFails ? "{}" : JSON.stringify({ state, name: "700MB-🧪.bin", size: 4,
            preparedBytes: state === "ready" ? 4 : 2, expiresAt: Date.now() + 60_000 }) });
      }
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
  return { context, page, calls, claimBodies, claimSessions,
    setInspectState(state) { forcedInspectState = state; } };
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

test("recipient waits and retries on the same capability until ready without claiming", { timeout: 30_000 }, async () => {
  await withBrowser(async (browser) => {
    const value = await recipientPage(browser, {
      inspectSequence: ["preparing", "transport-error", "ready"],
    });
    await value.page.getByRole("heading", { name: "Файл загружается" }).waitFor();
    await value.page.getByRole("heading", { name: "Не удалось проверить статус" }).waitFor();
    assert.equal(await value.page.getByRole("button", { name: "Проверить снова" }).count(), 1);
    assert.equal(await value.page.getByRole("button", { name: "Скачать" }).count(), 0);
    assert.equal(await value.page.getByText("700MB-🧪.bin").count(), 1,
      "transient polling failure must retain known file metadata");
    await value.page.getByRole("button", { name: "Проверить снова" }).click();
    await value.page.getByRole("button", { name: "Скачать" }).waitFor({ timeout: 8_000 });
    assert.equal(await value.page.getByText("Файл готов к защищённой загрузке.").count(), 1);
    assert.equal(value.calls.some((action) => ["challenge", "claim", "plan", "download"].includes(action)), false,
      "inspect polling and reconnect must not consume the capability");
    assert.equal(await value.page.evaluate(() => location.hash), capability);
    await value.context.close();
  });
});

test("concurrent early opens and reload keep waiting on the same link without claim", { timeout: 30_000 }, async () => {
  await withBrowser(async (browser) => {
    const value = await recipientPage(browser, { inspectSequence: ["preparing"] });
    await value.page.getByRole("heading", { name: "Файл загружается" }).waitFor();
    const second = await value.context.newPage();
    await second.goto(`https://downloads.example.test/transfer/${capability}`);
    await second.getByRole("heading", { name: "Файл загружается" }).waitFor();
    value.setInspectState("ready");
    await Promise.all([
      value.page.getByRole("button", { name: "Скачать" }).waitFor({ timeout: 8_000 }),
      second.getByRole("button", { name: "Скачать" }).waitFor({ timeout: 8_000 }),
    ]);
    assert.equal(value.calls.every((action) => action === "inspect"), true);
    await second.reload();
    await second.getByRole("button", { name: "Скачать" }).waitFor();
    assert.equal(await second.evaluate(() => location.hash), capability);
    assert.equal(value.calls.every((action) => action === "inspect"), true,
      "opening, polling and reload must not create a challenge or claim");
    await value.context.close();
  });
});

test("recipient renders reason-specific terminal states without Download", { timeout: 30_000 }, async () => {
  await withBrowser(async (browser) => {
    const expected = new Map([
      ["revoked", "Ссылка отозвана"],
      ["expired", "Срок ссылки истёк"],
      ["failed", "Не удалось подготовить файл"],
      ["cancelled", "Загрузка отменена"],
      ["claimed", "Ссылка уже использована"],
    ]);
    for (const [state, heading] of expected) {
      const value = await recipientPage(browser, { inspectSequence: [state] });
      await value.page.getByRole("heading", { name: heading }).waitFor();
      assert.equal(await value.page.getByRole("button", { name: "Скачать" }).count(), 0);
      assert.deepEqual(value.calls, ["inspect"]);
      await value.context.close();
    }
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
          body: JSON.stringify({ state: "ready", name: `${body.shareId}.bin`, size: 4,
            preparedBytes: 4, expiresAt: Date.now() + 60_000 }) });
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
}, async (t) => {
  await withBrowser(async (browser) => {
    const file = { name: "Очень-длинное-имя-данных-🧪-для-проверки-переноса-2026.bin", size: 700 * 1024 * 1024 };
    const artifact = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: file.name, size: file.size,
      sha256: "a".repeat(64), state: "ready", preparedBytes: file.size, expiresAt: Date.now() + 86_400_000 };
    const baseShare = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", artifactId: artifact.id,
      name: file.name, size: file.size, sha256: artifact.sha256, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000,
      claimedAt: Date.now() - 30_000, bytesServed: 240 * 1024 * 1024, preparedBytes: file.size };
    const cases = [
      ["owner-web-preparing-1280-dark", "Подготовка файла", { file, artifact: { ...artifact, state: "preparing", preparedBytes: 311 * 1024 * 1024 }, share: null }],
      ["owner-web-link-created-1280-dark", "Ссылка создана", { file,
        artifact: { ...artifact, state: "preparing", preparedBytes: 311 * 1024 * 1024 },
        share: { ...baseShare, state: "preparing", sha256: null, preparedBytes: 311 * 1024 * 1024,
          url: "https://downloads.example.test/transfer/#v1.hidden-capability" } }],
      ["owner-web-ready-1280-dark", "Ссылка готова", { file, artifact, share: { ...baseShare, state: "ready", url: "https://downloads.example.test/transfer/#v1.hidden-capability" } }],
      ["owner-web-claimed-1280-dark", "Ссылка использована", { file, artifact, share: { ...baseShare, state: "claimed" } }],
      ["owner-web-downloading-1280-dark", "Файл передаётся", { file, artifact, share: { ...baseShare, state: "downloading" } }],
      ["owner-web-completed-1280-dark", "Передача завершена", { file, artifact, share: { ...baseShare, state: "completed", completedAt: Date.now() } }],
      ["owner-web-expired-1280-dark", "Срок ссылки истёк", { file, artifact, share: { ...baseShare, state: "expired" } }],
      ["owner-web-revoked-1280-dark", "Ссылка отозвана", { file, artifact, share: { ...baseShare, state: "revoked" } }],
      ["owner-web-failed-1280-dark", "Не удалось подготовить файл", { file, artifact, share: { ...baseShare, state: "failed" } }],
      ["owner-web-cancelled-1280-dark", "Загрузка отменена", { file, artifact, share: { ...baseShare, state: "cancelled" } }],
    ];
    const captureOwnerState = async (name, heading, value, { statusFails = false } = {}) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      try {
        await page.setContent(`<!doctype html><html data-theme="orbit"><head><style>${ownerCss}</style></head><body><button id="open">Open</button></body></html>`);
        await page.addScriptTag({ content: ownerSource });
        await page.evaluate(async ({ snapshot, statusFails }) => {
          window.__snapshot = snapshot;
          window.AgentHubFileTransferOwner.configure(async (action) => {
            if (statusFails) throw new Error("offline");
            if (action === "status") return structuredClone(window.__snapshot);
            if (action === "revoke") return { share: { ...window.__snapshot.share, state: "revoked" } };
            throw new Error("unexpected action");
          });
          await window.AgentHubFileTransferOwner.open({ path: "D:/work/file.bin", trigger: document.querySelector("#open") });
        }, { snapshot: { ...value, ttlOptions: [3_600_000, 86_400_000] }, statusFails });
        await assertOwnerState(page, heading);
        await page.waitForFunction(() => document.querySelector(".file-transfer-owner-dialog")?.matches(":modal"));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const modalEvidence = async () => page.evaluate(() => {
          const dialog = document.querySelector(".file-transfer-owner-dialog");
          const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
          const rect = dialog.getBoundingClientRect();
          return {
            modal: dialog.matches(":modal"),
            header: visible(dialog.querySelector("header")),
            file: visible(dialog.querySelector(".file-transfer-owner-file")),
            heading: dialog.querySelector("#file-transfer-owner-state-title")?.textContent,
            actions: [...dialog.querySelectorAll("footer button")].filter(visible).map((button) => button.textContent),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            viewport: { width: innerWidth, height: innerHeight },
          };
        });
        const assertModalEvidence = (value) => {
          assert.equal(value.modal, true);
          assert.equal(value.header, true);
          assert.equal(value.file, true);
          assert.ok(value.rect.width > 0 && value.rect.height > 0, JSON.stringify(value));
          assert.ok(value.rect.x >= 0 && value.rect.y >= 0, JSON.stringify(value));
          assert.ok(value.rect.x + value.rect.width <= value.viewport.width + 1, JSON.stringify(value));
          assert.ok(value.rect.y + value.rect.height <= value.viewport.height + 1, JSON.stringify(value));
        };
        const before = await modalEvidence();
        assertModalEvidence(before);
        if (name === "owner-web-revoked-1280-dark") {
          assert.equal(before.heading, "Ссылка отозвана");
          assert.deepEqual(before.actions, ["Создать новую ссылку", "Закрыть"]);
        }
        await capture(page, name, { fullPage: false });
        const after = await modalEvidence();
        assertModalEvidence(after);
        if (name === "owner-web-revoked-1280-dark") {
          assert.equal(after.heading, "Ссылка отозвана");
          assert.deepEqual(after.actions, ["Создать новую ссылку", "Закрыть"]);
          t.diagnostic(`revoked-modal-evidence ${JSON.stringify({ before, after })}`);
        }
      } finally {
        await page.close();
      }
    };
    for (const [name, heading, value] of cases) await captureOwnerState(name, heading, value);
    await captureOwnerState("owner-web-unknown-1280-dark", "Не удалось получить актуальный статус",
      { file, artifact, share: null }, { statusFails: true });
  });
});

test("recipient production assets capture responsive dark and recovery states", {
  timeout: 60_000,
  skip: !captureDirectory,
}, async () => {
  await withBrowser(async (browser) => {
    const pending = await recipientPage(browser, { inspectSequence: ["preparing"], width: 430 });
    await pending.page.getByRole("heading", { name: "Файл загружается" }).waitFor();
    await capture(pending.page, "recipient-mobile-pending-430-light");
    await pending.context.close();

    const retry = await recipientPage(browser, { inspectSequence: ["preparing", "transport-error", "ready"], width: 320 });
    await retry.page.getByRole("heading", { name: "Файл загружается" }).waitFor();
    await retry.page.getByRole("heading", { name: "Не удалось проверить статус" }).waitFor();
    assert.equal(await retry.page.getByText("700MB-🧪.bin").count(), 1);
    assert.equal(await retry.page.getByRole("button", { name: "Скачать" }).count(), 0);
    await capture(retry.page, "recipient-mobile-status-retry-320-light");
    await retry.page.getByRole("button", { name: "Проверить снова" }).click();
    await retry.page.getByRole("button", { name: "Скачать" }).waitFor();
    assert.equal(retry.calls.some((action) => ["challenge", "claim", "plan", "download"].includes(action)), false);
    await retry.context.close();

    const dark = await recipientPage(browser, { colorScheme: "dark" });
    await dark.page.getByRole("button", { name: "Скачать" }).waitFor();
    await capture(dark.page, "recipient-mobile-ready-390-dark");
    await dark.context.close();

    const webview = await recipientPage(browser, { webview: true, width: 520 });
    await webview.page.getByRole("button", { name: "Копировать ссылку" }).waitFor();
    await capture(webview.page, "recipient-webview-handoff-520-light");
    await webview.context.close();

    const narrowWebview = await recipientPage(browser, { webview: true, width: 390 });
    await narrowWebview.page.getByRole("button", { name: "Копировать ссылку" }).waitFor();
    await capture(narrowWebview.page, "recipient-webview-handoff-390-light");
    await narrowWebview.context.close();

    for (const [state, heading] of [["expired", "Срок ссылки истёк"], ["revoked", "Ссылка отозвана"],
      ["failed", "Не удалось подготовить файл"], ["cancelled", "Загрузка отменена"],
      ["claimed", "Ссылка уже использована"]]) {
      const terminal = await recipientPage(browser, { inspectSequence: [state] });
      await terminal.page.getByRole("heading", { name: heading }).waitFor();
      await capture(terminal.page, `recipient-mobile-${state}-390-light`);
      await terminal.context.close();
    }

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
