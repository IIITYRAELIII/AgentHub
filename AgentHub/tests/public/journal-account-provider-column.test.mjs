import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { projectWorkLogUsage } from "../../src/application/work-log-usage-projection.mjs";
import { cosmeticMatrix } from "../helpers/test-profile.mjs";

const require = createRequire(import.meta.url);
const { loadThemeRegistry } = require("../../theme-registry.cjs");
const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);
const NOW = Date.parse("2026-09-03T12:00:00.000Z");

async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  if (process.platform === "win32") return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true });
}

function accountPanelMarkup() {
  const mixed = {
    accountKey: "anthropic:mixed",
    accountLabel: "mixed@example.test",
    accountPlan: "max:subscription",
    accountAttribution: "exact",
  };
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    codexSingle: {
      provider: "codex",
      threadId: "codex-single-thread",
      turnId: "codex-single-turn",
      completedAt: "2026-09-03T09:00:00.000Z",
      estimatedCredits: 8,
      accountKey: "chatgpt:single",
      accountLabel: "single@example.test",
      accountPlan: "plus",
      accountAttribution: "exact",
    },
    mixedClaude: {
      ...mixed,
      provider: "claude",
      threadId: "mixed-claude-thread",
      turnId: "mixed-claude-turn",
      completedAt: "2026-09-03T09:30:00.000Z",
      estimatedCredits: 5,
    },
    mixedCodex: {
      ...mixed,
      provider: "codex",
      threadId: "mixed-codex-thread",
      turnId: "mixed-codex-turn",
      completedAt: "2026-09-03T10:00:00.000Z",
      estimatedCredits: 4,
    },
    unknownPlan: {
      provider: "claude",
      threadId: "unknown-plan-thread",
      turnId: "unknown-plan-turn",
      completedAt: "2026-09-03T10:30:00.000Z",
      estimatedCredits: 2,
      accountKey: "anthropic:unknown-plan",
      accountLabel: "unknown-plan@example.test",
      accountPlan: "internal_billing_tier_v7",
      accountAttribution: "exact",
    },
  }, { now: NOW });
  const panel = /<!-- work-log-account-panel:start -->([\s\S]*?)<!-- work-log-account-panel:end -->/u
    .exec(projected)?.[1];
  assert.ok(panel, "account panel fixture was not projected");
  return panel;
}

function fixtureHtml({ surface = "desktop", theme = "orbit" } = {}) {
  return `<!doctype html>
<html data-surface="${surface}" data-theme="${theme}" data-view="statistics">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/themes/${theme}/theme.css">
  <style>
    html, body { margin: 0; min-height: 100%; }
    body { background: var(--bg); color: var(--text); padding: 16px; }
    .statistics-account-panel { margin: 0 auto; max-width: 1180px; min-width: 0; }
  </style>
</head>
<body><main class="statistics-account-panel">${accountPanelMarkup()}</main></body>
</html>`;
}

async function openFixture(page, options = {}) {
  const theme = options.theme ?? "orbit";
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "agent-hub.test") {
      await route.abort();
      return;
    }
    if (url.pathname === "/") {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fixtureHtml(options),
      });
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    try {
      await route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      await route.fulfill({ status: 404, body: `missing ${theme}` });
    }
  });
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.waitForSelector("[data-work-log-account-period-body][data-active]");
}

function inspectProviderRows() {
  const active = document.querySelector("[data-work-log-account-period-body][data-active]");
  const groups = [...active.querySelectorAll("[data-work-log-account-group]")];
  const byLabel = (label) => groups.find((group) => (
    group.querySelector("[data-work-log-account-label]")?.textContent === label
  ));
  const describe = (group) => {
    const provider = group.querySelector("[data-work-log-account-row] > [data-work-log-account-provider]");
    const rail = provider.querySelector("[data-work-log-account-provider-rail]");
    const labels = [...provider.querySelectorAll("[data-work-log-account-provider-label]")];
    const segments = [...rail.querySelectorAll("[data-work-log-account-provider-rail-segment]")];
    const plan = provider.querySelector("[data-work-log-account-plan]");
    const groupBox = group.getBoundingClientRect();
    const providerBox = provider.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    return {
      groupLeft: groupBox.left,
      groupRight: groupBox.right,
      providerLeft: providerBox.left,
      providerRight: providerBox.right,
      railLeft: railBox.left,
      railRight: railBox.right,
      railWidth: railBox.width,
      providerText: provider.textContent.trim(),
      labelTexts: labels.map((label) => label.textContent),
      labelColors: labels.map((label) => getComputedStyle(label).color),
      labelBorderLeftWidths: labels.map((label) => getComputedStyle(label).borderLeftWidth),
      providerBorderLeftWidth: getComputedStyle(provider).borderLeftWidth,
      segmentWidths: segments.map((segment) => segment.getBoundingClientRect().width),
      segmentColors: segments.map((segment) => getComputedStyle(segment).backgroundColor),
      planText: plan?.textContent ?? "",
      planBorderLeftWidth: plan ? getComputedStyle(plan).borderLeftWidth : "",
    };
  };
  return {
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    panelRight: document.querySelector("[data-work-log-account-panel]").getBoundingClientRect().right,
    single: describe(byLabel("single@example.test")),
    mixed: describe(byLabel("mixed@example.test")),
    unknownPlan: describe(byLabel("unknown-plan@example.test")),
  };
}

test("provider column renders one segmented key-line and only unambiguous plan badges", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await openFixture(page, { surface: "desktop", theme: "orbit" });
    const result = await page.evaluate(inspectProviderRows);

    assert.equal(result.single.railWidth, 2);
    assert.deepEqual(result.single.labelTexts, ["Codex"]);
    assert.equal(result.single.planText, "Plus");
    assert.deepEqual(result.single.segmentWidths, [2]);
    assert.equal(result.mixed.providerText, "Claude · Codex");
    assert.deepEqual(result.mixed.labelTexts, ["Claude", "Codex"]);
    assert.deepEqual(result.mixed.segmentWidths, [2, 2]);
    assert.notEqual(result.mixed.segmentColors[0], result.mixed.segmentColors[1]);
    assert.equal(result.mixed.planText, "");
    assert.equal(result.unknownPlan.planText, "");
    assert.ok(result.single.railLeft >= result.single.providerLeft);
    assert.ok(result.single.railRight <= result.single.providerRight);
  } finally {
    await browser.close();
  }
});

test("mobile keeps the only provider rail on the card edge without internal borders", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await openFixture(page, { surface: "mobile", theme: "orange" });
    const result = await page.evaluate(inspectProviderRows);

    for (const row of [result.single, result.mixed, result.unknownPlan]) {
      assert.ok(Math.abs(row.railLeft - row.groupLeft) < 0.51);
      assert.equal(row.railWidth, 2);
      assert.equal(row.providerBorderLeftWidth, "0px");
      assert.deepEqual(row.labelBorderLeftWidths, row.labelBorderLeftWidths.map(() => "0px"));
      assert.ok(row.railRight < row.providerLeft);
    }
    assert.deepEqual(result.mixed.segmentWidths, [2, 2]);
    assert.notEqual(result.mixed.segmentColors[0], result.mixed.segmentColors[1]);
    assert.equal(result.mixed.planText, "");
    assert.equal(result.single.planBorderLeftWidth, "0px");
    assert.ok(result.documentWidth <= result.viewportWidth);
  } finally {
    await browser.close();
  }
});

test("narrow desktop WebView reflows without page overflow", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    await page.addInitScript(() => { window.__agentHubVscode = true; });
    await openFixture(page, { surface: "desktop", theme: "graphite" });
    const result = await page.evaluate(inspectProviderRows);

    assert.ok(result.documentWidth <= result.viewportWidth);
    assert.ok(result.panelRight <= result.viewportWidth);
    assert.equal(result.single.railWidth, 2);
    assert.equal(result.single.planText, "Plus");
    assert.equal(result.mixed.providerText, "Claude · Codex");
  } finally {
    await browser.close();
  }
});

test("every shipped theme supplies provider tone geometry to the shared projection", cosmeticMatrix(), async () => {
  const registry = loadThemeRegistry(fileURLToPath(WEB_APP_ROOT));
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    for (const theme of registry.themes) {
      await page.unrouteAll({ behavior: "wait" });
      await openFixture(page, { surface: "desktop", theme: theme.id });
      const tokens = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const mixed = [...document.querySelectorAll("[data-work-log-account-group]")]
          .find((group) => group.querySelector("[data-work-log-account-label]")?.textContent === "mixed@example.test");
        const colors = [...mixed.querySelectorAll(
          ":scope > [data-work-log-account-row] > [data-work-log-account-provider] [data-work-log-account-provider-label]",
        )]
          .map((label) => getComputedStyle(label).color);
        return {
          lightness: root.getPropertyValue("--provider-tone-lightness").trim(),
          chroma: root.getPropertyValue("--provider-tone-chroma").trim(),
          alpha: root.getPropertyValue("--provider-tone-alpha").trim(),
          colors,
        };
      });
      assert.ok(tokens.lightness, `${theme.id} provider lightness token`);
      assert.ok(tokens.chroma, `${theme.id} provider chroma token`);
      assert.ok(tokens.alpha, `${theme.id} provider alpha token`);
      assert.equal(tokens.colors.length, 2, `${theme.id} mixed provider labels`);
      assert.notEqual(tokens.colors[0], tokens.colors[1], `${theme.id} provider hues stay distinct`);
    }
  } finally {
    await browser.close();
  }
});
