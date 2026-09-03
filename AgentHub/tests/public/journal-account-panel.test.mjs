import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8");

function accountPanelRules() {
  return [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(({ selector }) => selector.includes("work-log-account"));
}

async function accountPanelApi() {
  const source = await readFile(
    new URL("../../assets/web-app/journal-account-panel.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { Array, Object, Set, String, window });
  return window.AgentHubJournalAccountPanel;
}

test("journal regrouping moves the account usage panel to Statistics", () => {
  assert.match(app, /const statisticsAccountPanelHost = document\.querySelector/u);
  assert.match(app, /function currentWorkLogAccountPanel\(\)/u);
  assert.match(app, /function mountStatisticsAccountPanel\(\)/u);
  assert.match(app, /function replaceJournalGroupedContent\(content\)/u);
  assert.doesNotMatch(
    app,
    /journal\.replaceChildren\((?:dayGroupingContent|taskGroupingContent|periodGroupingContent)\(/u,
  );
  assert.match(
    app,
    /replaceJournalGroupedContent\(dayGroupingContent\(journal\)\)/u,
  );
  assert.match(
    app,
    /replaceJournalGroupedContent\(taskGroupingContent\(journal, grouping\)\)/u,
  );
  assert.match(
    app,
    /replaceJournalGroupedContent\(periodGroupingContent\(journal, grouping\)\)/u,
  );
});

test("usage sync controls live in Statistics instead of the Journal header", () => {
  assert.match(app, /const statisticsSyncCard = document\.querySelector/u);
  assert.match(app, /const statisticsSyncHost = document\.querySelector/u);
  assert.match(app, /function mountStatisticsSyncControls\(\)/u);
  assert.match(app, /function updateStatisticsSyncCardVisibility\(\)/u);
  assert.match(
    app,
    /statisticsSyncHost\.append\(control\)/u,
  );
  assert.match(
    app,
    /function usageSyncCanSetDeviceLabel\(status = null\) \{\s*\n\s*return Boolean\(status && typeof status === "object"\);\s*\n\s*\}/u,
  );
  assert.match(
    app,
    /journalSyncDeviceLabelButton\.textContent = status\?\.deviceLabelPromptRequired \|\| !label \? "Задать ник" : "Ник устройства";/u,
  );
  assert.match(
    app,
    /updateStatisticsSyncCardVisibility\(\);\s*\n\s*maybePromptUsageSyncDeviceLabel\(status\);\s*\n\s*return;/u,
  );
});

test("statistics view eagerly loads journal data for account usage and Sync controls", () => {
  assert.match(
    app,
    /if \(view === "statistics"\) \{\s*\n\s*ensureJournalLoaded\(\);/u,
  );
  assert.match(
    app,
    /Статистике нужны account panel и Sync status/u,
  );
});

/* Панель переносится клоном, поэтому собственные обработчики на плитках были бы
   потеряны при каждой смене группировки. */
test("account panel keeps its interaction after every journal regrouping", () => {
  assert.match(app, /refreshUsageUnits\(journal\);\s*\n\s*mountStatisticsAccountPanel\(\);/u);
  assert.match(app, /document\.addEventListener\("click", \(event\) => \{/u);
  assert.doesNotMatch(app, /\[data-work-log-account-period-tab\]"\)\)\s*\{\s*tab\.addEventListener/u);
});

/* Панель живёт во всех темах приложения, поэтому собственных цветов у неё нет:
   и оформление, и палитра аккаунта берутся только из токенов темы. */
test("account panel styling stays token-only across themes", () => {
  const rules = accountPanelRules();
  assert.ok(rules.length > 40, `нашлось только ${rules.length} правил панели`);
  for (const { selector, body } of rules) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/iu, `литеральный цвет в «${selector}»`);
    assert.doesNotMatch(body, /\b(?:rgba?|hsla?|oklch)\(/iu, `литеральный цвет в «${selector}»`);
  }
  const rowColors = rules.filter(({ selector }) => /data-account-color="\d"/u.test(selector));
  assert.equal(rowColors.length, 6, "палитра аккаунтов должна повторять серии статистики");
  assert.match(styles, /\[data-work-log-account-bar-device-fill\] \{[\s\S]*left: var\(--account-offset, 0%\);[\s\S]*width: var\(--account-share, 0%\);/u);
  assert.doesNotMatch(styles, /\[data-work-log-account-device-row\] \[data-work-log-account-bar-segment\]\[data-muted\]/u);
});

test("the selected period survives re-render and stays inside the known set", async () => {
  const api = await accountPanelApi();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.deepEqual([...api.RANGE_SEQUENCE], ["today", "24h", "7d", "15d", "30d", "all"]);
  assert.equal(api.storedRange(storage), "today");
  assert.equal(api.persistRange(storage, "15d"), "15d");
  assert.equal(api.storedRange(storage), "15d");
  assert.equal(api.persistRange(storage, "30d"), "30d");
  assert.equal(api.storedRange(storage), "30d");
  assert.equal(api.normalizeRange("нет такого"), "today");
  assert.equal(api.normalizeRange("30d", ["today", "all"]), "today");
  assert.equal(api.normalizeRange("all", ["today", "all"]), "all");

  const failing = {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
  };
  assert.equal(api.storedRange(failing), "today");
  assert.equal(api.persistRange(failing, "7d"), "7d");
});

test("expanded account devices survive re-render and support one expand-all toggle", async () => {
  const api = await accountPanelApi();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.deepEqual([...api.storedExpandedAccounts(storage)], []);
  assert.deepEqual([...api.toggleExpandedAccount([], "chatgpt:owner")], ["chatgpt:owner"]);
  assert.deepEqual([...api.toggleExpandedAccount(["chatgpt:owner"], "chatgpt:owner")], []);

  const expanded = api.toggleAllAccounts(["retired"], ["chatgpt:owner", "anthropic:owner"]);
  assert.deepEqual([...expanded], ["retired", "chatgpt:owner", "anthropic:owner"]);
  assert.equal(api.allAccountsExpanded(expanded, ["chatgpt:owner", "anthropic:owner"]), true);
  assert.equal(
    api.devicesToggleLabel(expanded, ["chatgpt:owner", "anthropic:owner"]),
    "Свернуть устройства",
  );
  assert.deepEqual(
    [...api.toggleAllAccounts(expanded, ["chatgpt:owner", "anthropic:owner"])],
    ["retired"],
  );
  assert.equal(
    api.devicesToggleLabel(["chatgpt:owner"], ["chatgpt:owner", "anthropic:owner"]),
    "Показать устройства",
  );

  assert.deepEqual(
    [...api.persistExpandedAccounts(storage, ["chatgpt:owner", "chatgpt:owner", ""])],
    ["chatgpt:owner"],
  );
  assert.deepEqual([...api.storedExpandedAccounts(storage)], ["chatgpt:owner"]);

  const failing = {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
  };
  assert.deepEqual([...api.storedExpandedAccounts(failing)], []);
  assert.deepEqual(
    [...api.persistExpandedAccounts(failing, ["chatgpt:owner"])],
    ["chatgpt:owner"],
  );
});

test("period tile splits the amount from its unit for every usage unit", async () => {
  const api = await accountPanelApi();

  const split = (value) => ({ ...api.splitUsageAmount(value) });

  assert.deepEqual(split("2,6 kcr"), { amount: "2,6", unit: "kcr" });
  assert.deepEqual(split("829,8 cr"), { amount: "829,8", unit: "cr" });
  assert.deepEqual(split("1,2 Mcr"), { amount: "1,2", unit: "Mcr" });
  assert.deepEqual(split("41,6 ПТЭ"), { amount: "41,6", unit: "ПТЭ" });
  assert.deepEqual(split("41,6 kПТЭ"), { amount: "41,6", unit: "kПТЭ" });
  assert.deepEqual(split("3,2 MПТЭ"), { amount: "3,2", unit: "MПТЭ" });
  assert.deepEqual(split("$12,3"), { amount: "$12,3", unit: "" });
  assert.deepEqual(split("₽1 234,5"), { amount: "₽1 234,5", unit: "" });
  assert.deepEqual(split(""), { amount: "", unit: "" });
});
