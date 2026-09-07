import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const VERSION = "sha256:journal-virtual-ui";
const THEME_CATALOG = JSON.stringify([{
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
  return "application/octet-stream";
}

function bucket(overrides = {}) {
  return {
    date: "07.09.2026",
    dayMs: Date.UTC(2026, 8, 7),
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    workspaceKind: "catalog",
    streamId: "stream-high",
    streamDisplayName: "High",
    streamOrdinal: 1,
    provider: "codex",
    turnCount: 1,
    credits: 30,
    knownCredits: 1,
    unknownCredits: 0,
    durationSeconds: 90,
    knownDurations: 1,
    unknownDurations: 0,
    latestAt: Date.UTC(2026, 8, 7, 12),
    fileTouches: 4,
    knownFileTouches: 1,
    changedLines: 25,
    knownChangedLines: 1,
    subagentTurns: 0,
    knownSubagentTurns: 1,
    skillNames: ["browser-qa"],
    mcpCallCount: 2,
    mcpTools: ["agent_hub/hub_task_get"],
    mcpFailures: 0,
    knownToolMetricTurns: 1,
    ...overrides,
  };
}

async function openProductionJournal(page) {
  const requests = [];
  const profileSummary = { version: 1, buckets: [
    bucket(),
    bucket({
      streamId: "stream-low",
      streamDisplayName: "Low",
      credits: 10,
      durationSeconds: 30,
      latestAt: Date.UTC(2026, 8, 7, 11),
      fileTouches: 1,
      changedLines: 3,
      skillNames: [],
      mcpCallCount: 0,
      mcpTools: [],
    }),
  ] };
  const summary = {
    version: 1,
    buckets: profileSummary.buckets.map((entry) => Object.fromEntries(Object.entries(entry)
      .filter(([key]) => ![
        "fileTouches", "knownFileTouches", "changedLines", "knownChangedLines",
        "subagentTurns", "knownSubagentTurns", "skillNames", "mcpCallCount",
        "mcpTools", "mcpFailures", "knownToolMetricTurns",
      ].includes(key)))),
  };
  await page.addInitScript(() => {
    localStorage.setItem("agent-hub-grouping", "stream");
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/api/journal/turns") {
      requests.push(url.toString());
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          conflict: false,
          version: VERSION,
          profileSummary,
          turns: [{
            turnRef: "turn-ref-high",
            date: "07.09.2026",
            html: '<div data-work-log-turn-entry data-work-log-turn-provider="codex"'
              + ' data-work-log-turn-thread-id="thread-high" data-work-log-turn-id="turn-high"'
              + ' data-work-log-turn-depth="0" data-work-log-turn-credits="30"'
              + ' data-work-log-turn-duration-seconds="90"'
              + ' data-work-log-turn-completed-at="2026-09-07T12:00:00.000Z">'
              + '<details data-work-log-turn-details data-lazy-turn-id="turn-ref-high">'
              + '<summary><span data-work-log-turn-title>High turn</span></summary>'
              + '<div data-lazy-turn-content></div></details></div>',
          }],
          nextOffset: null,
        }),
      });
    }
    if (url.pathname === "/api/journal") {
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: { ETag: `"${VERSION}"` },
        body: JSON.stringify({
          html: '<details data-work-log-day-section data-lazy-day="07.09.2026">'
            + '<summary data-work-log-day><strong>07.09.2026</strong></summary>'
            + '<div data-lazy-day-content></div></details>',
          summary,
          updatedAt: "2026-09-07T12:00:00.000Z",
          version: VERSION,
          usageSync: { configured: false },
        }),
      });
    }
    if (url.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${THEME_CATALOG}</script></head>`);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    if (url.pathname === "/work-log.css") {
      return route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    try {
      return route.fulfill({
        status: 200,
        contentType: contentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.locator('[data-view-button="journal"]').click();
  await page.locator('[data-journal-virtual-mode="stream"]').first().waitFor();
  await page.locator("[data-journal-profile-metrics]").first().waitFor();
  return requests;
}

test("virtual Stream mode preserves overview profile and default-open semantics", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const requests = await openProductionJournal(page);
    const groups = page.locator('[data-journal-virtual-mode="stream"]');
    assert.equal(await groups.count(), 2);
    assert.equal(await groups.nth(0).getAttribute("open"), "");
    assert.equal(await groups.nth(1).getAttribute("open"), null);
    assert.match(await groups.nth(0).locator("[data-journal-ledger-title]").innerText(), /High/u);
    assert.equal(await groups.nth(0).locator("[data-journal-group-overview]").count(), 1);
    assert.equal(await groups.nth(0).locator("[data-work-log-task-profile]").count(), 1);
    assert.equal(await groups.nth(1).locator("[data-work-log-task-profile]").count(), 0);
    assert.notEqual(
      await groups.nth(0).locator("[data-radar-current]").getAttribute("points"),
      await groups.nth(0).locator("[data-radar-baseline]").getAttribute("points"),
    );
    assert.match(
      await groups.nth(0).locator('[data-journal-profile-metric="fileTouches"]').innerText(),
      /4 кас\./u,
    );
    assert.match(await groups.nth(0).locator("[data-work-log-turn-title]").innerText(), /High turn/u);
    assert.equal(requests.length, 1);
    const request = new URL(requests[0]);
    assert.equal(request.searchParams.get("profileMode"), "stream");
    assert.equal(request.searchParams.get("workspaceId"), "workspace-1");
    assert.equal(request.searchParams.get("streamId"), "stream-high");
    assert.equal(request.searchParams.get("version"), VERSION);
  } finally {
    await browser.close();
  }
});
