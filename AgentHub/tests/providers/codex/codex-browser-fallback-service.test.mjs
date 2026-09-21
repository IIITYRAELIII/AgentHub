import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexBrowserFallbackService } from "../../../src/providers/codex/codex-browser-fallback-service.mjs";

const CONTEXT = {
  provider: "codex",
  threadId: "thread-1",
  streamId: "stream-1",
};

function fakeChromium({
  hangingGoto = false,
  hangingLaunch = false,
  hangingContextClose = false,
  popupOnClick = false,
} = {}) {
  const state = {
    launches: 0,
    contexts: 0,
    contextCloses: 0,
    browserCloses: 0,
    pageCloses: 0,
    clicks: [],
    fills: [],
    presses: [],
  };
  const chromium = {
    launch: async () => {
      state.launches += 1;
      if (hangingLaunch) return new Promise(() => {});
      let connected = true;
      return {
        isConnected: () => connected,
        on() {},
        newContext: async () => {
          state.contexts += 1;
          const pages = [];
          const createPage = ({ initialTitle = "Blank", initialUrl = "about:blank" } = {}) => {
            let closed = false;
            let url = initialUrl;
            let title = initialTitle;
            const page = {
              isClosed: () => closed,
              close: async () => { closed = true; state.pageCloses += 1; },
              setDefaultTimeout() {},
              setDefaultNavigationTimeout() {},
              goto: async (next) => {
                if (hangingGoto) return new Promise(() => {});
                url = next;
                title = "Agent Hub Browser";
              },
              url: () => url,
              title: async () => title,
              locator: (selector) => ({
                ariaSnapshot: async () => `- document: ${title}\n- selector: ${selector}`,
                innerText: async () => title,
                click: async () => {
                  state.clicks.push(selector);
                  if (popupOnClick && selector === "#popup") {
                    pages.push(createPage({ initialTitle: "Popup target", initialUrl: "https://popup.test/" }));
                  }
                },
                fill: async (text) => state.fills.push([selector, text]),
                press: async (key) => state.presses.push([selector, key]),
              }),
              screenshot: async ({ path: screenshotPath }) => writeFile(screenshotPath, "png"),
            };
            return page;
          };
          const page = createPage();
          pages.push(page);
          const browserContext = {
            newPage: async () => page,
            pages: () => pages,
            close: async () => {
              state.contextCloses += 1;
              if (hangingContextClose) return new Promise(() => {});
            },
          };
          return browserContext;
        },
        close: async () => { connected = false; state.browserCloses += 1; },
      };
    },
  };
  return { chromium, state };
}

test("Edge fallback reuses one isolated Thread session across navigation and interaction", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-fallback-"));
  const fake = fakeChromium();
  const service = new CodexBrowserFallbackService({
    dataDir,
    loadChromium: async () => fake.chromium,
    launchOptions: { headless: true },
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const opened = await service.invoke(CONTEXT, {
    action: "open",
    url: "https://example.test/start",
  });
  const filled = await service.invoke(CONTEXT, {
    action: "fill",
    selector: "#query",
    text: "Agent Hub",
  });
  await service.invoke(CONTEXT, { action: "click", selector: "#submit" });
  await service.invoke(CONTEXT, { action: "press", selector: "#query", key: "Enter" });
  const screenshot = await service.invoke(CONTEXT, { action: "screenshot" });

  assert.equal(opened.sessionReused, false);
  assert.equal(filled.sessionReused, true);
  assert.equal(fake.state.launches, 1);
  assert.equal(fake.state.contexts, 1);
  assert.deepEqual(fake.state.fills, [["#query", "Agent Hub"]]);
  assert.deepEqual(fake.state.clicks, ["#submit"]);
  assert.deepEqual(fake.state.presses, [["#query", "Enter"]]);
  assert.equal(await readFile(screenshot.screenshotPath, "utf8"), "png");
  assert.match(opened.snapshot, /Agent Hub Browser/u);

  assert.equal(await service.closeForThread("thread-1"), true);
  await assert.rejects(access(screenshot.screenshotPath));
  assert.equal(fake.state.contextCloses, 1);
  assert.equal(fake.state.browserCloses, 0, "the one Edge process remains reusable until reset");
  await service.reset();
  assert.equal(fake.state.browserCloses, 1);
});

test("fallback rejects unsafe targets and non-Codex callers before launching Edge", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-policy-"));
  const fake = fakeChromium();
  const service = new CodexBrowserFallbackService({ dataDir, loadChromium: async () => fake.chromium });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(
    service.invoke({ ...CONTEXT, provider: "claude" }, { action: "open", url: "https://example.test" }),
    /only to Codex/u,
  );
  await assert.rejects(
    service.invoke(CONTEXT, { action: "open", url: "file:///private.txt" }),
    /http or https/u,
  );
  await assert.rejects(
    service.invoke(CONTEXT, { action: "open", url: "https://user:secret@example.test" }),
    /must not contain credentials/u,
  );
  assert.equal(fake.state.launches, 0);
});

test("a timed out browser operation closes its exact Thread context", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-timeout-"));
  const fake = fakeChromium({ hangingGoto: true });
  const service = new CodexBrowserFallbackService({
    dataDir,
    operationTimeoutMs: 20,
    loadChromium: async () => fake.chromium,
    launchOptions: { headless: true },
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(
    service.invoke(CONTEXT, { action: "open", url: "https://example.test/hang" }),
    (error) => error.code === "CODEX_BROWSER_TIMEOUT",
  );
  assert.equal(fake.state.contextCloses, 1);
  assert.equal(service.diagnostics().sessions, 0);
});

test("concurrent calls reuse one session while distinct Threads get isolated contexts", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-concurrency-"));
  const fake = fakeChromium();
  const service = new CodexBrowserFallbackService({
    dataDir,
    loadChromium: async () => fake.chromium,
    launchOptions: { headless: true },
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    service.invoke(CONTEXT, { action: "open", url: "https://example.test/first" }),
    service.invoke(CONTEXT, { action: "snapshot" }),
  ]);
  const otherContext = { ...CONTEXT, threadId: "thread-2" };
  await service.invoke(otherContext, { action: "open", url: "https://example.test/second" });

  assert.equal(first.sessionReused, false);
  assert.equal(second.sessionReused, true);
  assert.equal(fake.state.launches, 1);
  assert.equal(fake.state.contexts, 2);
  assert.equal(service.diagnostics().sessions, 2);

  assert.equal(await service.closeForThread("thread-1"), true);
  assert.equal(service.diagnostics().sessions, 1);
  assert.equal(fake.state.contextCloses, 1);
  const remaining = await service.invoke(otherContext, { action: "snapshot" });
  assert.equal(remaining.threadId, "thread-2");
  assert.equal(remaining.sessionReused, true);
});

test("a popup replaces the owned page instead of leaving duplicate Edge tabs", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-popup-"));
  const fake = fakeChromium({ popupOnClick: true });
  const service = new CodexBrowserFallbackService({
    dataDir,
    loadChromium: async () => fake.chromium,
    launchOptions: { headless: true },
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await service.invoke(CONTEXT, { action: "open", url: "https://example.test/start" });
  const clicked = await service.invoke(CONTEXT, { action: "click", selector: "#popup" });
  const snapshot = await service.invoke(CONTEXT, { action: "snapshot" });

  assert.equal(clicked.url, "https://popup.test/");
  assert.equal(snapshot.title, "Popup target");
  assert.equal(fake.state.pageCloses, 1, "the replaced page is closed after adopting the popup");
  assert.equal(fake.state.contexts, 1);
  assert.equal(service.diagnostics().sessions, 1);
});

test("hanging context cleanup is bounded, retires Edge and permits a clean replacement", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-hanging-cleanup-"));
  const fake = fakeChromium({ hangingGoto: true, hangingContextClose: true });
  const service = new CodexBrowserFallbackService({
    dataDir,
    operationTimeoutMs: 15,
    cleanupTimeoutMs: 15,
    loadChromium: async () => fake.chromium,
    launchOptions: { headless: true },
    logger: { warn() {} },
  });
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  await assert.rejects(
    service.invoke(CONTEXT, { action: "open", url: "https://example.test/hang" }),
    (error) => error.code === "CODEX_BROWSER_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 500, "timeout cleanup must not wait forever");
  const replacement = await service.invoke(CONTEXT, { action: "snapshot" });
  assert.equal(fake.state.contextCloses, 1);
  assert.equal(fake.state.browserCloses, 1);
  assert.equal(fake.state.launches, 2);
  assert.equal(replacement.title, "Blank");
  assert.equal(service.diagnostics().browserProcess, true);
  assert.equal(service.diagnostics().sessions, 1);
});

test("hanging Edge launch is bounded and close does not leave a pending owner", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-hanging-launch-"));
  const fake = fakeChromium({ hangingLaunch: true });
  const service = new CodexBrowserFallbackService({
    dataDir,
    operationTimeoutMs: 15,
    cleanupTimeoutMs: 15,
    loadChromium: async () => fake.chromium,
    launchOptions: { headless: true },
  });
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  await assert.rejects(
    service.invoke(CONTEXT, { action: "open", url: "https://example.test/hang-launch" }),
    (error) => error.code === "CODEX_BROWSER_TIMEOUT",
  );
  const startedAt = Date.now();
  await service.close();
  assert.ok(Date.now() - startedAt < 500, "service close must own a bounded launch cleanup");
  assert.equal(service.diagnostics().status, "closed");
  assert.equal(service.diagnostics().startingSessions, 0);
});

test("installed Edge fallback performs navigation, DOM interaction and screenshot", {
  skip: process.platform !== "win32" ? "Microsoft Edge regression is Windows-specific" : false,
  timeout: 60_000,
}, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-browser-edge-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>HUB Browser Probe</title>
      <label>Name <input id="name"></label>
      <button id="go" onclick="document.querySelector('#result').textContent='Hello ' + document.querySelector('#name').value">Go</button>
      <main id="result">Ready</main>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const service = new CodexBrowserFallbackService({
    dataDir,
    launchOptions: { headless: true },
  });
  t.after(async () => {
    await service.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const opened = await service.invoke(CONTEXT, {
    action: "open",
    url: `http://127.0.0.1:${address.port}/probe`,
  });
  await service.invoke(CONTEXT, { action: "fill", selector: "#name", text: "Codex" });
  const clicked = await service.invoke(CONTEXT, { action: "click", selector: "#go" });
  const screenshot = await service.invoke(CONTEXT, { action: "screenshot" });

  assert.equal(opened.title, "HUB Browser Probe");
  assert.match(clicked.snapshot, /Hello Codex/u);
  await access(screenshot.screenshotPath);
  assert.equal(screenshot.sessionReused, true);
  assert.equal(service.diagnostics().sessions, 1);
});
