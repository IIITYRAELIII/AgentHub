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

async function openProductionJournal(page, {
  grouping = "stream",
  groupStreams = true,
  summaryBuckets = null,
  getVersion = () => VERSION,
  turnPageResponse = null,
  journalRequests = [],
  waitForProfile = true,
} = {}) {
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
    buckets: (summaryBuckets ?? profileSummary.buckets).map((entry) => Object.fromEntries(Object.entries(entry)
      .filter(([key]) => ![
        "fileTouches", "knownFileTouches", "changedLines", "knownChangedLines",
        "subagentTurns", "knownSubagentTurns", "skillNames", "mcpCallCount",
        "mcpTools", "mcpFailures", "knownToolMetricTurns",
      ].includes(key)))),
  };
  await page.addInitScript(({ initialGrouping, nested }) => {
    localStorage.setItem("agent-hub-grouping", initialGrouping);
    localStorage.setItem("agent-hub-journal-stream-groups", nested ? "on" : "off");
  }, { initialGrouping: grouping, nested: groupStreams });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") return route.abort();
    if (url.pathname === "/api/journal/turns") {
      requests.push(url.toString());
      const payload = {
          conflict: false,
          version: getVersion(),
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
      };
      const result = await turnPageResponse?.({ payload, url, requestNumber: requests.length });
      return route.fulfill({
        status: result?.status ?? 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(result?.payload ?? payload),
      });
    }
    if (url.pathname === "/api/journal") {
      const version = getVersion();
      journalRequests.push(version);
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: { ETag: `"${version}"` },
        body: JSON.stringify({
          html: '<details data-work-log-day-section data-lazy-day="07.09.2026">'
            + '<summary data-work-log-day><strong>07.09.2026</strong></summary>'
            + '<div data-lazy-day-content></div></details>',
          summary,
          updatedAt: "2026-09-07T12:00:00.000Z",
          version,
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
  await page.locator(`[data-journal-virtual-mode="${grouping}"]`).first().waitFor();
  if (grouping === "stream" && waitForProfile) await page.locator("[data-journal-profile-metrics]").first().waitFor();
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

test("QU keeps values and missing-data dashes without disclaimers in totals, turns and breakdowns", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true } : { headless: true });
  try {
    for (const grouping of ["stream", "workspace", "date"]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const breakdown = [
        ["Вход", 1.25], ["Кэш", 2.5], ["Запись кэша", 0],
        ["Выход", null], ["Думы", 4],
      ].map(([label, quota]) => `<span data-task-usage-part>${label}: `
        + `<span data-kilo-usage data-usage-credits="6" data-usage-qu-incomplete="1"`
        + `${quota === null ? "" : ` data-usage-qu="${quota}"`}>6 cr</span></span>`).join("");
      await openProductionJournal(page, { grouping, summaryBuckets: [
        bucket({ quotaUnits: 45, knownQuotaUnits: 1, unknownQuotaUnits: 0, uncalibratedCount: 0 }),
        bucket({ streamId: "stream-low", streamDisplayName: "Low", credits: 10,
          quotaUnits: 0, knownQuotaUnits: 1, unknownQuotaUnits: 0, uncalibratedCount: 1 }),
      ], turnPageResponse: ({ payload }) => ({ payload: { ...payload, turns: [{
        ...payload.turns[0],
        html: payload.turns[0].html
          .replace('data-work-log-turn-credits="30"', 'data-work-log-turn-credits="30"'
            + ' data-work-log-turn-quota-units="45" data-work-log-turn-quota-incomplete="1"')
          .replace(' data-lazy-turn-id="turn-ref-high"', "")
          .replace('</summary>', '<span data-work-log-turn-meta></span></summary>')
          .replace('<div data-lazy-turn-content></div>', `<div data-task-usage-breakdown>${breakdown}</div>`),
      }] } }) });
      await page.locator(`[data-journal-virtual-mode="${grouping}"]`).first()
        .evaluate((details) => { details.open = true; });
      if (grouping === "stream") {
        await page.locator('[data-work-log-turn-entry]').first().waitFor();
        await page.locator('[data-work-log-turn-details]').first()
          .evaluate((details) => { details.open = true; });
      }
      await page.locator('[data-usage-unit="qu"]').first().evaluate((button) => button.click());
      await page.waitForFunction(() => document.querySelector('[data-journal-total-credits]')
        ?.textContent?.includes('45 QU'));
      assert.equal(await page.locator('[data-journal-total-credits]').innerText(), "45 QU");
      if (grouping === "stream") {
        const groups = page.locator('[data-journal-virtual-mode="stream"]');
        assert.match(await groups.nth(0).locator('[data-journal-ledger-metric="credits"]').innerText(), /45 QU/u);
        assert.equal(await groups.nth(1).locator('[data-usage-qu]').textContent(), "— QU");
        assert.equal(await groups.nth(1).locator('[data-usage-qu]').getAttribute('data-usage-qu-incomplete'), "1");
      } else {
        const metric = grouping === "workspace" ? '[data-journal-ledger-metric="credits"]'
          : '[data-journal-day-picker-credits]';
        assert.equal(await page.locator(metric).first().locator('[data-usage-qu]').textContent(), "45 QU");
      }
      const turn = page.locator('[data-work-log-turn-entry]').first();
      const parts = turn.locator('[data-task-usage-part] [data-kilo-usage]');
      if (grouping === "stream") {
        await parts.last().waitFor({ state: "attached" });
        assert.equal(await turn.locator('[data-journal-turn-cost]').textContent(), "45 QU");
        assert.equal(await turn.locator('[data-journal-turn-cost] [data-usage-qu]')
          .getAttribute('data-usage-qu-incomplete'), "1");
        assert.deepEqual(await parts.allTextContents(), ["1,3 QU", "2,5 QU", "— QU", "— QU", "4 QU"]);
        assert.deepEqual(await parts.evaluateAll((nodes) => nodes.map((node) => node.dataset.usageQu)),
          ["1.25", "2.5", "0", undefined, "4"]);
      }
      assert.doesNotMatch(await page.locator('[data-journal]').textContent(), /неполно|≈/u);
      await page.locator('[data-usage-unit="cr"]').first().evaluate((button) => button.click());
      await page.waitForFunction(() => document.querySelector('[data-journal-total-credits]')
        ?.textContent?.includes('40 cr'));
      assert.match(await page.locator('[data-journal-total-credits]').innerText(), /40 cr/u);
      if (grouping === "stream") {
        await parts.last().waitFor({ state: "attached" });
        assert.deepEqual(await parts.allTextContents(), Array(5).fill("6 cr"));
        await page.locator('[data-usage-unit="qu"]').first().evaluate((button) => button.click());
        await parts.last().waitFor({ state: "attached" });
        assert.deepEqual(await parts.allTextContents(), ["1,3 QU", "2,5 QU", "— QU", "— QU", "4 QU"]);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("journal version conflict refreshes once and restores the open Stream without an error", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true } : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let version = "journal-v1";
    const journalRequests = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = await openProductionJournal(page, {
      getVersion: () => version,
      journalRequests,
      turnPageResponse: ({ requestNumber }) => {
        if (requestNumber !== 1) return null;
        version = "journal-v2";
        return { status: 409, payload: { error: "Журнал обновился.", version } };
      },
    });
    await page.locator("[data-work-log-turn-title]").first().waitFor();
    assert.deepEqual(journalRequests, ["journal-v1", "journal-v2"]);
    assert.deepEqual(requests.map((request) => new URL(request).searchParams.get("version")), ["journal-v1", "journal-v2"]);
    assert.equal(await page.locator('[data-journal-virtual-mode="stream"]').first().getAttribute("open"), "");
    assert.doesNotMatch(await page.locator("[data-toast]").innerText(), /Не удалось/u);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("late journal page from the previous version neither refreshes nor mutates the new scope", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true } : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let version = "journal-v1";
    let release;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const journalRequests = [];
    const requests = await openProductionJournal(page, {
      getVersion: () => version,
      journalRequests,
      waitForProfile: false,
      turnPageResponse: async ({ payload, requestNumber }) => {
        if (requestNumber !== 1) return null;
        markStarted();
        await gate;
        return { payload: { ...payload, turns: payload.turns.map((turn) => ({
          ...turn, html: turn.html.replace("High turn", "STALE TURN"),
        })), profileSummary: { version: 1, buckets: [bucket({ fileTouches: 999 })] } } };
      },
    });
    await started;
    version = "journal-v2";
    await page.locator("[data-refresh]").click();
    await page.locator("[data-work-log-turn-title]").first().waitFor();
    const before = await page.locator('[data-journal-virtual-mode="stream"]').first().innerHTML();
    const response = page.waitForResponse((value) => value.url().includes("/api/journal/turns")
      && new URL(value.url()).searchParams.get("version") === "journal-v1");
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(journalRequests, ["journal-v1", "journal-v2"]);
    assert.equal(requests.length, 2);
    assert.equal(await page.locator('[data-journal-virtual-mode="stream"]').first().innerHTML(), before);
    assert.doesNotMatch(await page.locator("[data-toast]").innerText(), /Не удалось/u);
  } finally {
    await browser.close();
  }
});

test("journal page service failures remain visible and do not trigger version reconciliation", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true } : { headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const journalRequests = [];
    const requests = await openProductionJournal(page, {
      journalRequests,
      waitForProfile: false,
      turnPageResponse: () => ({ status: 503, payload: { error: "Storage unavailable" } }),
    });
    await page.getByText("Не удалось загрузить ходы: Storage unavailable", { exact: true }).waitFor();
    assert.equal(journalRequests.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(await page.locator('[data-journal-virtual-turns][aria-busy="true"]').count(), 0);
  } finally {
    await browser.close();
  }
});

test("date week month and Workspace modes keep complete percentage metrics with either nesting", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.platform === "win32"
    ? { channel: "msedge", headless: true }
    : { headless: true });
  const summaryBuckets = [
    bucket({ turnCount: 3, credits: 30, durationSeconds: 90 }),
    bucket({
      streamId: "stream-low",
      streamDisplayName: "Low",
      turnCount: 1,
      credits: 10,
      durationSeconds: 30,
    }),
    bucket({
      workspaceId: "workspace-2",
      workspaceName: "Other",
      streamId: "stream-other",
      streamDisplayName: "Other stream",
      turnCount: 1,
      credits: 20,
      durationSeconds: 60,
    }),
  ];
  try {
    for (const grouping of ["date", "week", "month", "workspace"]) {
      for (const groupStreams of [true, false]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await openProductionJournal(page, { grouping, groupStreams, summaryBuckets });
        const firstScope = page.locator(`[data-journal-virtual-mode="${grouping}"]`).first();
        if (await firstScope.getAttribute("open") === null) {
          await firstScope.locator(":scope > summary").click();
        }
        if (grouping !== "workspace") {
          const workspace = firstScope.locator('[data-journal-day-picker-item][data-selected]');
          const unselected = firstScope.locator('[data-journal-day-picker-item]:not([data-selected])');
          assert.match(await workspace.locator("[data-journal-day-picker-turns]").innerText(), /4 ходов\s*\(80%\)/iu);
          assert.match(await workspace.locator("[data-journal-day-picker-duration]").innerText(), /2 мин\s*\(67%\)/u);
          assert.match(await workspace.locator("[data-journal-day-picker-credits]").innerText(), /40[\s\S]*\(67%\)/u);
          assert.equal(await unselected.locator("[data-journal-day-picker-turns]").isVisible(), true);
          assert.equal(await unselected.locator("[data-journal-day-picker-duration]").isVisible(), true);
          assert.equal(await unselected.locator("[data-journal-day-picker-credits]").isVisible(), true);
          assert.match(await unselected.locator("[data-journal-day-picker-turns]").innerText(), /1 ходов\s*\(20%\)/iu);
          assert.match(await unselected.locator("[data-journal-day-picker-duration]").innerText(), /1 мин\s*\(33%\)/u);
          assert.match(await unselected.locator("[data-journal-day-picker-credits]").innerText(), /20[\s\S]*\(33%\)/u);
        }
        if (groupStreams) {
          const stream = firstScope.locator("[data-work-log-stream-summary]").first();
          assert.match(await stream.locator("[data-work-log-stream-turn-count]").innerText(), /3 ход\.\s*\(75%\)/u);
          assert.match(await stream.locator("[data-work-log-stream-duration]").innerText(), /1 мин 30 с\s*\(75%\)/u);
          assert.match(await stream.locator("[data-work-log-stream-credits]").innerText(), /30/u);
          assert.match(await stream.locator("[data-work-log-stream-credit-share]").innerText(), /\(75%\)/u);
        } else {
          assert.equal(await firstScope.locator("[data-work-log-stream-summary]").count(), 0);
          const flatTurns = grouping === "workspace"
            ? firstScope.locator("[data-journal-virtual-flat-turns]")
            : firstScope.locator("[data-journal-day-panel]:not([hidden]) [data-journal-virtual-flat-turns]");
          assert.equal(await flatTurns.count(), 1);
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
