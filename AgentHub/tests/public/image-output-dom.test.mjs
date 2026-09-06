import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopAttachmentService } from "../../src/interfaces/desktop/desktop-attachment-service.mjs";
import { MiniAppPublisher } from "../../src/interfaces/web/mini-app-publisher.mjs";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const TEST_THEME_CATALOG = JSON.stringify([{
  id: "orbit",
  name: "Orbit",
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);
const TEST_SNAPSHOT = {
  apiVersion: 3,
  version: "attachment-viewer-test",
  server: { status: "online" },
  tasks: [],
  workspaces: [],
  archivedWorkspaces: [],
  boardTasks: [],
  boardLayout: { columnOrder: [] },
  deferredInputs: [],
  messageReceipts: [],
  pendingApprovals: [],
  settings: {
    provider: "codex",
    models: [],
    modelOptionsByProvider: {},
    reasoningOptions: [],
    reasoningOptionsByProvider: {},
    modeOptions: [],
    quickMessages: { global: [], workspaces: {}, streams: {} },
  },
};
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function contentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

async function openProductionAssets(page, {
  includeHubClient = false,
  waitForClient = true,
  control = null,
  resource = null,
} = {}) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "agent-hub.test") {
      await route.abort();
      return;
    }
    if (requestUrl.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      let body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "");
      if (!includeHubClient) {
        body = body.replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "");
      }
      body = body.replace(
        "</head>",
        `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`,
      );
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      return;
    }
    if (requestUrl.pathname === "/api/control" && route.request().method() === "POST") {
      const request = route.request().postDataJSON();
      const result = await control?.(request) ?? TEST_SNAPSHOT;
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(result?.ok === true ? result : { ok: true, result }),
      });
      return;
    }
    if (["/api/control/ack", "/api/command-trace/client-ack"].includes(requestUrl.pathname)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" });
      return;
    }
    if (await resource?.(requestUrl, route)) return;
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
  await page.goto("https://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
  if (includeHubClient && waitForClient) {
    await page.waitForFunction(() => document.querySelector("[data-connection-label]")?.textContent !== "");
  }
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

test("shipped remote viewer opens a production-sized image from its durable resource URL", async () => {
  const { chromium } = await import("playwright");
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  const fullBody = await readFile(new URL(
    "../../assets/wallpapers/telegram-gothic-void-desktop-v2.png",
    import.meta.url,
  ));
  assert.ok(fullBody.length > 2_784_684);
  const requests = [];
  let openAttachmentCalls = 0;
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { window.__agentHubAttachmentViewerLoadTimeoutMs = 2_000; });
    await openProductionAssets(page, {
      includeHubClient: true,
      control: async ({ action, params }) => {
        if (action !== "open-attachment") return TEST_SNAPSHOT;
        openAttachmentCalls += 1;
        assert.equal(params.id, "codex-generated-dragon.png");
        return {
          id: params.id,
          name: "Изображение",
          type: "image/png",
          url: "/api/message-attachment/codex-generated-dragon.png",
        };
      },
      resource: async (url, route) => {
        if (url.pathname.endsWith("codex-generated-dragon.png") && url.searchParams.get("preview") === "1") {
          await route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG });
          return true;
        }
        if (url.pathname.endsWith("codex-generated-dragon.png")) {
          requests.push(url.pathname);
          await new Promise((resolve) => setTimeout(resolve, 120));
          await route.fulfill({ status: 200, contentType: "image/png", body: fullBody });
          return true;
        }
        return false;
      },
    });
    await page.evaluate(() => {
      const taskId = "task-full-image";
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
        selected: true,
      }]);
      window.AgentHub.setMessages(taskId, [{
        id: "turn-dragon",
        itemId: "turn-dragon:agent:final",
        turnId: "turn-dragon",
        role: "agent",
        text: "Вот дракон.",
        attachments: [{
          id: "codex-generated-dragon.png",
          name: "Изображение",
          type: "image/png",
          thumbnailUrl: "/api/message-attachment/codex-generated-dragon.png?preview=1",
        }],
      }]);
    });

    await page.locator('.msg-agent[data-turn-id="turn-dragon"] .attachment-image').click();
    assert.equal(await page.locator("[data-attachment-viewer-loading]").isVisible(), true);
    await page.waitForFunction(() => {
      const image = document.querySelector("[data-attachment-viewer-image]");
      const loading = document.querySelector("[data-attachment-viewer-loading]");
      return image?.naturalWidth > 0 || loading?.classList.contains("is-error");
    });

    const result = await page.evaluate(() => {
      const viewer = document.querySelector("[data-attachment-viewer]");
      const image = document.querySelector("[data-attachment-viewer-image]");
      const loading = document.querySelector("[data-attachment-viewer-loading]");
      return {
        open: viewer.open,
        imageSrc: image.getAttribute("src"),
        imageHidden: image.hidden,
        naturalWidth: image.naturalWidth,
        loadingHidden: loading.hidden,
        loadingText: loading.textContent,
      };
    });
    assert.equal(result.open, true);
    assert.equal(result.imageSrc, "/api/message-attachment/codex-generated-dragon.png");
    assert.equal(result.imageHidden, false);
    assert.ok(result.naturalWidth > 0);
    assert.equal(result.loadingHidden, true);
    assert.equal(result.loadingText, "Загрузка…");
    assert.equal(openAttachmentCalls, 1);
    assert.deepEqual(requests, ["/api/message-attachment/codex-generated-dragon.png"]);
  } finally {
    await browser.close();
  }
});

test("shipped Telegram viewer loads the production publisher shape through authenticated Blob URL", async () => {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-telegram-viewer-"));
  const attachments = path.join(root, "attachments");
  const secretFile = path.join(root, "sync.secret");
  const source = path.join(attachments, "image-telegram.png");
  const fullBody = await readFile(new URL(
    "../../assets/wallpapers/telegram-gothic-void-desktop-v2.png",
    import.meta.url,
  ));
  assert.ok(fullBody.length > 2_784_684);
  await mkdir(attachments, { recursive: true });
  await writeFile(source, fullBody);
  await writeFile(secretFile, "w".repeat(64));
  let pushes = 0;
  let publishedBody = null;
  let publishedAccess = null;
  let viewRequests = 0;
  let authorization = "";
  const missingViewId = "018f6c86-3f34-7a31-8f27-16f5b96cce42";
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://agent-hub.test",
    syncSecretFile: secretFile,
    attachmentDirectory: attachments,
    fetchImpl: async (_url, options) => {
      pushes += 1;
      publishedBody = Buffer.from(options.body);
      return Response.json({ ok: true, expiresAt: Date.now() + 60_000 }, { status: 201 });
    },
  });
  const service = new DesktopAttachmentService({
    runtimeCommandRoot: root,
    projectRoot: root,
    workerEnabled: true,
    trustedUserId: () => "42",
    publisher: () => publisher,
  });
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.addInitScript(() => {
      window.__agentHubAttachmentViewerLoadTimeoutMs = 2_000;
      window.__agentHubAttachmentFetchTimeoutMs = 2_000;
      window.Telegram = {
        WebApp: {
          initData: "query_id=test&auth_date=1&hash=test",
          platform: "android",
          ready() {},
          expand() {},
        },
      };
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      window.__viewerObjectUrls = { created: 0, revoked: 0 };
      URL.createObjectURL = (blob) => {
        window.__viewerObjectUrls.created += 1;
        return create(blob);
      };
      URL.revokeObjectURL = (url) => {
        window.__viewerObjectUrls.revoked += 1;
        return revoke(url);
      };
    });
    try {
      await openProductionAssets(page, {
        includeHubClient: true,
        waitForClient: false,
        control: async ({ action, params }) => {
          if (action !== "open-attachment") return TEST_SNAPSHOT;
          if (params.id === "missing-telegram.png") {
            return {
              id: missingViewId,
              name: "Недоступное изображение",
              type: "image/png",
              expiresAt: Date.now() + 60_000,
            };
          }
          assert.equal(params.id, "image-telegram.png");
          publishedAccess = await service.open(params, { source: "telegram-mini-app" });
          assert.equal(publishedAccess.url, undefined);
          return publishedAccess;
        },
        resource: async (url, route) => {
          if (url.pathname !== "/api/attachment/view") return false;
          viewRequests += 1;
          authorization = route.request().headers().authorization ?? "";
          if (url.searchParams.get("id") === missingViewId) {
            await route.fulfill({ status: 404, body: "Not found" });
            return true;
          }
          assert.equal(url.searchParams.get("id"), publishedAccess.id);
          await route.fulfill({
            status: 200,
            headers: {
              "Cache-Control": "private, no-store",
              "Content-Type": "image/png",
              "Content-Length": String(publishedBody.length),
              "X-Content-Type-Options": "nosniff",
            },
            body: publishedBody,
          });
          return true;
        },
      });
    } catch (error) {
      assert.fail(`${error.message}; browser errors: ${browserErrors.join(" | ")}`);
    }
    await page.evaluate(() => {
      const taskId = "task-telegram-image";
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
        selected: true,
      }]);
      window.AgentHub.setMessages(taskId, [{
        id: "turn-telegram-image",
        itemId: "turn-telegram-image:agent:final",
        turnId: "turn-telegram-image",
        role: "agent",
        text: "Telegram image",
        attachments: [{
          id: "image-telegram.png",
          name: "Изображение",
          type: "image/png",
          thumbnailUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }, {
          id: "missing-telegram.png",
          name: "Недоступное изображение",
          type: "image/png",
          thumbnailUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }],
      }]);
    });

    await page.locator('[data-mobile-button="chat"]').click();
    await page.locator('.msg-agent[data-turn-id="turn-telegram-image"] .attachment-image')
      .first()
      .click();
    await page.waitForFunction(() => {
      const image = document.querySelector("[data-attachment-viewer-image]");
      return image?.naturalWidth > 0 && !image.hidden;
    });
    const loaded = await page.evaluate(() => ({
      src: document.querySelector("[data-attachment-viewer-image]")?.getAttribute("src"),
      width: document.querySelector("[data-attachment-viewer-image]")?.naturalWidth,
      height: document.querySelector("[data-attachment-viewer-image]")?.naturalHeight,
      loadingHidden: document.querySelector("[data-attachment-viewer-loading]")?.hidden,
      objectUrls: { ...window.__viewerObjectUrls },
    }));
    assert.match(loaded.src, /^blob:https:\/\/agent-hub\.test\//u);
    assert.ok(loaded.width > 0 && loaded.height > 0);
    assert.equal(loaded.loadingHidden, true);
    assert.deepEqual(loaded.objectUrls, { created: 1, revoked: 0 });
    assert.equal(pushes, 1);
    assert.deepEqual(publishedBody, fullBody);
    assert.equal(viewRequests, 1);
    assert.equal(authorization, "tma query_id=test&auth_date=1&hash=test");

    await page.locator("[data-attachment-viewer-next]").click();
    await page.waitForFunction(() => window.__viewerObjectUrls.revoked === 1);
    await page.waitForFunction(() => {
      const loading = document.querySelector("[data-attachment-viewer-loading]");
      return loading?.classList.contains("is-error") && /HTTP 404/u.test(loading.textContent);
    });
    assert.equal(viewRequests, 2);
    assert.equal(pushes, 1);

    await page.locator("[data-attachment-viewer-previous]").click();
    await page.waitForFunction(() => {
      const image = document.querySelector("[data-attachment-viewer-image]");
      return image?.naturalWidth > 0 && !image.hidden
        && window.__viewerObjectUrls.created === 2;
    });
    assert.equal(viewRequests, 3);
    assert.equal(pushes, 2);
    assert.deepEqual(await page.evaluate(() => window.__viewerObjectUrls), {
      created: 2,
      revoked: 1,
    });

    await page.locator("[data-attachment-viewer-close]").click();
    await page.waitForFunction(() => window.__viewerObjectUrls.revoked === 2);
    assert.deepEqual(await page.evaluate(() => window.__viewerObjectUrls), {
      created: 2,
      revoked: 2,
    });
  } finally {
    await browser.close();
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a delayed Telegram open cannot displace the current viewer generation", async () => {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-telegram-viewer-race-"));
  const attachments = path.join(root, "attachments");
  const secretFile = path.join(root, "sync.secret");
  const fullBody = await readFile(new URL(
    "../../assets/wallpapers/telegram-gothic-void-desktop-v2.png",
    import.meta.url,
  ));
  await mkdir(attachments, { recursive: true });
  await writeFile(path.join(attachments, "image-a.png"), fullBody);
  await writeFile(path.join(attachments, "image-b.png"), fullBody);
  await writeFile(secretFile, "r".repeat(64));

  let releaseA;
  const delayedA = new Promise((resolve) => { releaseA = resolve; });
  let markAStarted;
  const aStarted = new Promise((resolve) => { markAStarted = resolve; });
  let markAResolved;
  const aResolved = new Promise((resolve) => { markAResolved = resolve; });
  let releaseB;
  const delayedB = new Promise((resolve) => { releaseB = resolve; });
  let markBFetchStarted;
  const bFetchStarted = new Promise((resolve) => { markBFetchStarted = resolve; });
  const bodies = new Map();
  const accesses = new Map();
  const viewIds = [];
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://agent-hub.test",
    syncSecretFile: secretFile,
    attachmentDirectory: attachments,
    fetchImpl: async (_url, options) => {
      const id = String(options.headers["X-Agent-Hub-Attachment-Id"]);
      bodies.set(id, Buffer.from(options.body));
      return Response.json({ ok: true, expiresAt: Date.now() + 60_000 }, { status: 201 });
    },
  });
  const service = new DesktopAttachmentService({
    runtimeCommandRoot: root,
    projectRoot: root,
    workerEnabled: true,
    trustedUserId: () => "42",
    publisher: () => publisher,
  });
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__agentHubAttachmentViewerLoadTimeoutMs = 2_000;
      window.Telegram = {
        WebApp: {
          initData: "query_id=race&auth_date=1&hash=test",
          platform: "android",
          ready() {},
          expand() {},
        },
      };
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      window.__viewerObjectUrls = { created: 0, revoked: 0 };
      URL.createObjectURL = (blob) => {
        window.__viewerObjectUrls.created += 1;
        return create(blob);
      };
      URL.revokeObjectURL = (url) => {
        window.__viewerObjectUrls.revoked += 1;
        return revoke(url);
      };
    });
    await openProductionAssets(page, {
      includeHubClient: true,
      waitForClient: false,
      control: async ({ action, params }) => {
        if (action !== "open-attachment") return TEST_SNAPSHOT;
        if (params.id === "image-a.png") {
          markAStarted();
          await delayedA;
        }
        const access = await service.open(params, { source: "telegram-mini-app" });
        accesses.set(params.id, access);
        if (params.id === "image-a.png") markAResolved();
        return access;
      },
      resource: async (url, route) => {
        if (url.pathname !== "/api/attachment/view") return false;
        const id = String(url.searchParams.get("id"));
        viewIds.push(id);
        if (id === accesses.get("image-b.png")?.id) {
          markBFetchStarted();
          await delayedB;
        }
        await route.fulfill({
          status: 200,
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Type": "image/png",
            "Content-Length": String(bodies.get(id)?.length ?? 0),
            "X-Content-Type-Options": "nosniff",
          },
          body: bodies.get(id),
        });
        return true;
      },
    });
    await page.evaluate(() => {
      const taskId = "task-telegram-race";
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
        selected: true,
      }]);
      window.AgentHub.setMessages(taskId, [{
        id: "turn-telegram-race",
        itemId: "turn-telegram-race:agent:final",
        turnId: "turn-telegram-race",
        role: "agent",
        text: "Telegram race",
        attachments: ["image-a.png", "image-b.png"].map((id) => ({
          id,
          name: id,
          type: "image/png",
          thumbnailUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        })),
      }]);
    });
    await page.locator('[data-mobile-button="chat"]').click();
    const images = page.locator('.msg-agent[data-turn-id="turn-telegram-race"] .attachment-image');
    const aControlResponse = page.waitForResponse((response) => {
      if (!response.url().endsWith("/api/control")) return false;
      const request = response.request();
      if (request.method() !== "POST") return false;
      try {
        const body = request.postDataJSON();
        return body?.action === "open-attachment" && body?.params?.id === "image-a.png";
      } catch {
        return false;
      }
    });
    await images.nth(0).click();
    await aStarted;
    await page.locator("[data-attachment-viewer-close]").click();
    await images.nth(1).click();
    await bFetchStarted;

    releaseA();
    await aResolved;
    await aControlResponse;
    releaseB();
    await page.waitForFunction(() => {
      const image = document.querySelector("[data-attachment-viewer-image]");
      return image?.naturalWidth > 0 && !image.hidden;
    });
    assert.deepEqual(viewIds, [accesses.get("image-b.png").id]);
    assert.deepEqual(await page.evaluate(() => window.__viewerObjectUrls), {
      created: 1,
      revoked: 0,
    });
    assert.equal(
      await page.locator("[data-attachment-viewer-name]").textContent(),
      "image-b.png",
    );

    await page.locator("[data-attachment-viewer-close]").click();
    await page.waitForFunction(() => window.__viewerObjectUrls.revoked === 1);
    assert.deepEqual(await page.evaluate(() => window.__viewerObjectUrls), {
      created: 1,
      revoked: 1,
    });
  } finally {
    releaseA?.();
    releaseB?.();
    await browser.close();
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram fetch and image settlement share the viewer absolute deadline", async () => {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-telegram-viewer-deadline-"));
  const attachments = path.join(root, "attachments");
  const secretFile = path.join(root, "sync.secret");
  await mkdir(attachments, { recursive: true });
  await writeFile(path.join(attachments, "image-deadline.png"), ONE_PIXEL_PNG);
  await writeFile(secretFile, "d".repeat(64));
  let viewRequests = 0;
  let authorization = "";
  const bodies = new Map();
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://agent-hub.test",
    syncSecretFile: secretFile,
    attachmentDirectory: attachments,
    fetchImpl: async (_url, options) => {
      bodies.set(String(options.headers["X-Agent-Hub-Attachment-Id"]), Buffer.from(options.body));
      return Response.json({ ok: true, expiresAt: Date.now() + 60_000 }, { status: 201 });
    },
  });
  const service = new DesktopAttachmentService({
    runtimeCommandRoot: root,
    projectRoot: root,
    workerEnabled: true,
    trustedUserId: () => "42",
    publisher: () => publisher,
  });
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__agentHubAttachmentViewerLoadTimeoutMs = 300;
      window.Telegram = {
        WebApp: {
          initData: "query_id=deadline&auth_date=1&hash=test",
          platform: "android",
          ready() {},
          expand() {},
        },
      };
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      window.__viewerObjectUrls = { created: 0, revoked: 0 };
      URL.createObjectURL = (blob) => {
        window.__viewerObjectUrls.created += 1;
        return create(blob);
      };
      URL.revokeObjectURL = (url) => {
        window.__viewerObjectUrls.revoked += 1;
        return revoke(url);
      };
    });
    await openProductionAssets(page, {
      includeHubClient: true,
      waitForClient: false,
      control: async ({ action, params }) => {
        if (action !== "open-attachment") return TEST_SNAPSHOT;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return service.open(params, { source: "telegram-mini-app" });
      },
      resource: async (url, route) => {
        if (url.pathname !== "/api/attachment/view") return false;
        viewRequests += 1;
        authorization = route.request().headers().authorization ?? "";
        const id = String(url.searchParams.get("id"));
        await new Promise((resolve) => setTimeout(resolve, 350));
        try {
          await route.fulfill({
            status: 200,
            headers: {
              "Cache-Control": "private, no-store",
              "Content-Type": "image/png",
              "Content-Length": String(bodies.get(id)?.length ?? 0),
              "X-Content-Type-Options": "nosniff",
            },
            body: bodies.get(id),
          });
        } catch {
          // The one absolute viewer deadline is expected to abort this stale request.
        }
        return true;
      },
    });
    await page.evaluate(() => {
      const taskId = "task-telegram-deadline";
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
        selected: true,
      }]);
      window.AgentHub.setMessages(taskId, [{
        id: "turn-telegram-deadline",
        itemId: "turn-telegram-deadline:agent:final",
        turnId: "turn-telegram-deadline",
        role: "agent",
        text: "Telegram deadline",
        attachments: [{
          id: "image-deadline.png",
          name: "Deadline image",
          type: "image/png",
          thumbnailUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }],
      }]);
    });
    await page.locator('[data-mobile-button="chat"]').click();
    await page.locator('.msg-agent[data-turn-id="turn-telegram-deadline"] .attachment-image').click();
    const openedAuthority = await page.evaluate(() => window.AgentHub.attachmentViewerLoadAuthority());
    assert.equal(openedAuthority.current, true);
    await page.waitForFunction(() => document.querySelector("[data-attachment-viewer-loading]")
      ?.textContent === "Изображение не загрузилось вовремя");
    const settled = await page.evaluate(() => ({
      now: performance.now(),
      authority: window.AgentHub.attachmentViewerLoadAuthority(),
    }));
    assert.equal(settled.authority.deadlineAt, openedAuthority.deadlineAt);
    assert.ok(
      settled.now <= openedAuthority.deadlineAt + 200,
      `Telegram viewer settled ${settled.now - openedAuthority.deadlineAt}ms after its absolute deadline`,
    );
    await page.waitForTimeout(350);
    assert.equal(
      await page.locator("[data-attachment-viewer-loading]").textContent(),
      "Изображение не загрузилось вовремя",
    );
    assert.deepEqual(await page.evaluate(() => window.__viewerObjectUrls), {
      created: 0,
      revoked: 0,
    });
    assert.equal(viewRequests, 1);
    assert.equal(authorization, "tma query_id=deadline&auth_date=1&hash=test");
  } finally {
    await browser.close();
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("image viewer leaves loading visibly on failure and timeout without accepting stale loads", async () => {
  const { chromium } = await import("playwright");
  const browser = process.platform === "win32"
    ? await chromium.launch({ channel: "msedge", headless: true })
    : await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { window.__agentHubAttachmentViewerLoadTimeoutMs = 160; });
    await openProductionAssets(page, {
      includeHubClient: true,
      control: async ({ action, params }) => action === "open-attachment"
        ? {
            id: params.id,
            name: "Недоступное изображение",
            type: "image/png",
            url: "/missing.png",
          }
        : TEST_SNAPSHOT,
      resource: async (url, route) => {
        if (url.pathname !== "/deadline.png") return false;
        await new Promise((resolve) => setTimeout(resolve, 140));
        await route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG });
        return true;
      },
    });
    await page.evaluate(() => {
      const taskId = "task-missing-image";
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
        status: "ready",
        selected: true,
      }]);
      window.AgentHub.setMessages(taskId, [{
        id: "turn-missing",
        itemId: "turn-missing:agent:final",
        turnId: "turn-missing",
        role: "agent",
        text: "Изображение недоступно",
        attachments: [{
          id: "codex-generated-missing.png",
          name: "Недоступное изображение",
          type: "image/png",
          thumbnailUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }],
      }]);
    });
    await page.locator('.msg-agent[data-turn-id="turn-missing"] .attachment-image').click();
    await page.waitForFunction(() => document.querySelector("[data-attachment-viewer-loading]")
      ?.textContent === "Не удалось загрузить изображение");
    assert.equal(await page.locator("[data-attachment-viewer]").getAttribute("open"), "");

    const firstGeneration = await page.evaluate(() => window.AgentHub.openAttachmentViewer({
      dataUrl: "/missing.png",
      name: "Повреждённое изображение",
    }));
    await page.waitForFunction(() => document.querySelector("[data-attachment-viewer-loading]")
      ?.textContent === "Не удалось загрузить изображение");

    const secondGeneration = await page.evaluate(() => window.AgentHub.openAttachmentViewer({
      name: "Медленное изображение",
    }));
    assert.ok(secondGeneration > firstGeneration);
    await page.waitForFunction(() => document.querySelector("[data-attachment-viewer-loading]")
      ?.textContent === "Изображение не загрузилось вовремя");
    const result = await page.evaluate((staleGeneration) => {
      window.AgentHub.showAttachmentViewer({
        dataUrl: "/late.png",
        name: "Устаревшее изображение",
        index: 0,
        generation: staleGeneration,
      });
      const image = document.querySelector("[data-attachment-viewer-image]");
      const loading = document.querySelector("[data-attachment-viewer-loading]");
      return {
        imageSrc: image.getAttribute("src"),
        imageHidden: image.hidden,
        loadingText: loading.textContent,
        error: loading.classList.contains("is-error"),
      };
    }, firstGeneration);
    assert.deepEqual(result, {
      imageSrc: null,
      imageHidden: true,
      loadingText: "Изображение не загрузилось вовремя",
      error: true,
    });

    const absoluteDeadline = await page.evaluate(() => {
      const startedAt = performance.now();
      const generation = window.AgentHub.openAttachmentViewer({ name: "Единый дедлайн" });
      return {
        startedAt,
        generation,
        deadlineAt: window.AgentHub.attachmentViewerLoadAuthority({ generation, index: 0 }).deadlineAt,
      };
    });
    await page.waitForTimeout(90);
    const deadlineAfterSource = await page.evaluate(({ generation }) => {
      window.AgentHub.showAttachmentViewer({
        dataUrl: "/deadline.png",
        name: "Единый дедлайн",
        generation,
        index: 0,
      });
      return window.AgentHub.attachmentViewerLoadAuthority({ generation, index: 0 }).deadlineAt;
    }, absoluteDeadline);
    assert.equal(deadlineAfterSource, absoluteDeadline.deadlineAt);
    await page.waitForFunction(() => document.querySelector("[data-attachment-viewer-loading]")
      ?.textContent === "Изображение не загрузилось вовремя");
    const elapsed = await page.evaluate((startedAt) => performance.now() - startedAt, absoluteDeadline.startedAt);
    assert.ok(elapsed >= 140, `deadline fired too early after ${elapsed}ms`);
    assert.ok(elapsed < 230, `source assignment renewed the 160ms deadline to ${elapsed}ms`);
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator("[data-attachment-viewer-loading]").textContent(),
      "Изображение не загрузилось вовремя",
    );
  } finally {
    await browser.close();
  }
});
