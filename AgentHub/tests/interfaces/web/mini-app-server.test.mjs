import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractWorkLogHtml,
  miniAppMenuButtonRequests,
  MiniAppServer,
  PublicAuthAttemptLimiter,
  validateTelegramInitData,
} from "../../../src/interfaces/web/mini-app-server.mjs";
import { buildLazyJournalPayload } from "../../../src/interfaces/web/mini-app-journal-data.mjs";
import { createAttachmentStorageName } from "../../../src/domain/attachment-files.mjs";

const LIMITS_HTML = '<div data-work-log-rate-limits data-sampled-at="2026-07-30T02:55:14.512Z">'
  + '<span data-rate-limit-caption>Лимиты</span>'
  + '<span data-rate-limit><span data-rate-limit-name>CODEX</span>'
  + '<span data-rate-limit-value>75.0%</span></span></div>';

const DAY_HTML = [
  '<details data-work-log-day-section open>',
  '<summary data-work-log-day><strong>27.07.2026</strong></summary>',
  '<div data-work-log-table>Пилот</div>',
  "</details>",
].join("");
const BOT_TOKEN = "123456789:test-token";

function memoryJournal(html = "") {
  let revision = 0;
  let current;
  const listeners = new Set();
  const replace = (nextHtml) => {
    revision += 1;
    current = {
      ...buildLazyJournalPayload(nextHtml),
      updatedAt: new Date(Date.UTC(2026, 6, 27, 12, 0, revision)).toISOString(),
      version: `sha256:${String(revision).padStart(64, "0")}`,
      revision,
    };
    for (const listener of listeners) listener({ type: "revision", revision });
  };
  replace(html);
  return {
    payload: async () => ({
      html: current.html,
      updatedAt: current.updatedAt,
      version: current.version,
      revision: current.revision,
    }),
    snapshot: async () => structuredClone(current),
    fragment: async (kind, key) => current[kind === "day" ? "days" : "turns"]?.[key] ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace,
    close() {},
  };
}

function signedInitData({
  authDate = Math.floor(Date.now() / 1_000),
  user = { id: 42, first_name: "Иван" },
} = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "test-query",
    user: JSON.stringify(user),
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

test("Mini App menu button is registered globally and for every allowed chat", () => {
  const requests = miniAppMenuButtonRequests({
    url: "https://journal.example/",
    text: "Журнал",
    chatIds: new Set([42, 84]),
  });
  assert.deepEqual(requests, [
    {
      menu_button: {
        type: "web_app",
        text: "Журнал",
        web_app: { url: "https://journal.example/" },
      },
    },
    {
      chat_id: 42,
      menu_button: {
        type: "web_app",
        text: "Журнал",
        web_app: { url: "https://journal.example/" },
      },
    },
    {
      chat_id: 84,
      menu_button: {
        type: "web_app",
        text: "Журнал",
        web_app: { url: "https://journal.example/" },
      },
    },
  ]);
});

test("extractWorkLogHtml returns generated journal days without the Markdown heading", () => {
  assert.equal(
    extractWorkLogHtml(`# Глобальный журнал работ\n\n${DAY_HTML}\n`),
    DAY_HTML,
  );
});

test("extractWorkLogHtml escapes an unprojected journal", () => {
  assert.equal(
    extractWorkLogHtml("# Глобальный журнал работ\n\n<unsafe>"),
    "<pre data-mini-app-fallback>&lt;unsafe&gt;</pre>",
  );
});

test("Mini App serves only safe persistent message attachment names", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-attachment-"));
  const attachments = path.join(directory, "attachments");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    attachmentDirectory: attachments,
  });
  try {
    await mkdir(attachments, { recursive: true });
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(path.join(attachments, "message-1.png"), body);
    const address = await server.start();
    const image = await fetch(`${address.url}api/message-attachment/message-1.png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), body);
    const documentId = createAttachmentStorageName("Требования.pdf", "01234567-89ab-cdef-0123-456789abcdef");
    await writeFile(path.join(attachments, documentId), Buffer.from("document"));
    const document = await fetch(`${address.url}api/message-attachment/${documentId}`);
    assert.equal(document.status, 200);
    assert.equal(document.headers.get("content-type"), "application/pdf");
    assert.match(document.headers.get("content-disposition"), /attachment;/u);
    assert.match(document.headers.get("content-disposition"), /filename\*=UTF-8''/u);
    assert.equal(document.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      (await fetch(`${address.url}api/message-attachment/..%2Fsecret.png`)).status,
      404,
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Telegram Mini App initData is signed, fresh and allowlisted", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const initData = signedInitData({ authDate: Math.floor(now / 1_000) });
  assert.equal(validateTelegramInitData(initData, {
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    now,
  }).id, 42);
  assert.throws(() => validateTelegramInitData(`${initData}x`, {
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    now,
  }), /hash|signature/u);
  assert.throws(() => validateTelegramInitData(initData, {
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([7]),
    now,
  }), /not allowed/u);
  assert.throws(() => validateTelegramInitData(signedInitData({
    authDate: Math.floor(now / 1_000) - 86_401,
  }), {
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    now,
  }), /expired/u);
});

test("task profile compares tasks only within the same provider", async () => {
  const script = await readFile(
    new URL("../../../assets/mini-app/app.js", import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /const comparableCohort = cohort\.filter\(\(item\) => item\.provider === group\.provider\)/u,
  );
  assert.match(script, /Относительно видимых задач \$\{providerLabel\}/u);
});

test("Mini App serves the SQLite journal and announces revision changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-"));
  const journalDatabase = memoryJournal(DAY_HTML);
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase,
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
  });
  const abort = new AbortController();
  try {
    const address = await server.start();

    const health = await fetch(`${address.url}health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.match(health.headers.get("content-security-policy"), /default-src 'self'/);

    const journal = await fetch(`${address.url}api/journal`);
    const payload = await journal.json();
    assert.equal(payload.html, DAY_HTML);
    assert.match(payload.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(payload.version, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(journal.headers.get("etag"), `"${payload.version}"`);
    const unchanged = await fetch(`${address.url}api/journal`, {
      headers: { "If-None-Match": `"${payload.version}"` },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");

    const externalHeaders = { "CF-Connecting-IP": "203.0.113.10" };
    assert.equal((await fetch(`${address.url}api/journal`, {
      headers: externalHeaders,
    })).status, 401);
    assert.equal((await fetch(`${address.url}api/journal`, {
      headers: {
        ...externalHeaders,
        Authorization: `tma ${signedInitData()}`,
      },
    })).status, 200);

    const shellSource = await (await fetch(address.url)).text();
    assert.match(shellSource, /data-dialog-settings/u);
    assert.match(shellSource, /data-dialog-agent/u);
    assert.doesNotMatch(shellSource, /data-dialog-options="agent"/u);
    assert.match(shellSource, /data-action="task-new" data-provider="codex"/u);
    assert.match(shellSource, /data-action="task-new" data-provider="claude"/u);
    assert.match(shellSource, /data-status-slot/u);
    assert.match(shellSource, /data-browser-auth/u);
    assert.match(shellSource, /src="\/browser-device-auth\.js"/u);
    const browserAuthSource = await (await fetch(`${address.url}browser-device-auth.js`)).text();
    assert.match(browserAuthSource, /indexedDB\.open\(DATABASE_NAME, 1\)/u);
    assert.match(browserAuthSource, /crypto\.subtle\.generateKey\([\s\S]*false,[\s\S]*\["sign", "verify"\]/u);
    assert.match(browserAuthSource, /\/api\/device\/pair/u);
    assert.match(browserAuthSource, /\/api\/device\/challenge/u);
    assert.match(browserAuthSource, /\/api\/device\/session/u);
    assert.doesNotMatch(browserAuthSource, /localStorage|sessionStorage/u);
    const appSource = await (await fetch(`${address.url}app.js`)).text();
    assert.match(appSource, /setTaskDiff\(taskId, text\)/u);
    assert.match(appSource, /class: "task-diff"/u);
    assert.match(appSource, /emit\("task:new", \{ title, provider \}\)/u);
    assert.match(appSource, /data-dialog-settings-open/u);
    const clientSource = await (await fetch(`${address.url}hub-client.js`)).text();
    assert.match(clientSource, /agentHub\.setTaskDiff\(targetId/u);
    assert.match(clientSource, /control\("new-task", \{[\s\S]*provider: selectedProvider,[\s\S]*workspaceName: title \|\| undefined,[\s\S]*\}\)/u);
    assert.doesNotMatch(clientSource, /agent: "provider"/u);
    assert.doesNotMatch(clientSource, /setStatus\(\{ rows: \[\{ name: "Diff"/u);

    for (const pathname of [
      "",
      "browser-device-auth.js",
      "app.js",
      "themes/metropolis/metropolis-glass.js",
      "themes/stormglass/storm-glass.js",
      "themes/metropolis/theme.css",
      "message-lifecycle.js",
      "hub-client.js",
      "styles.css",
      "work-log.css",
    ]) {
      const response = await fetch(`${address.url}${pathname}`);
      assert.equal(response.status, 200, pathname || "/");
      assert.ok((await response.text()).length > 20);
    }
    /* Фирменный знак относится к оболочке, а не к пакету темы: один immutable
       PNG одинаково обслуживает Web, VS Code и экран доверия браузеру. */
    const appMark = await fetch(`${address.url}agent-hub-mark.png`);
    assert.equal(appMark.status, 200);
    assert.equal(appMark.headers.get("content-type"), "image/png");
    assert.match(appMark.headers.get("cache-control"), /immutable/u);
    assert.ok((await appMark.arrayBuffer()).byteLength > 20_000);
    const blackHole = await fetch(`${address.url}themes/blackhole/blackhole-blue.jpg`);
    assert.equal(blackHole.status, 200);
    assert.equal(blackHole.headers.get("content-type"), "image/jpeg");
    assert.match(blackHole.headers.get("cache-control"), /immutable/u);
    const gothicImage = await fetch(`${address.url}themes/gothic/gothic-concrete.jpg`);
    assert.equal(gothicImage.status, 200);
    assert.equal(gothicImage.headers.get("content-type"), "image/jpeg");
    assert.match(gothicImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await gothicImage.arrayBuffer()).byteLength > 100_000);
    const nebulaImage = await fetch(`${address.url}themes/nebula/nebula-veil.jpg`);
    assert.equal(nebulaImage.status, 200);
    assert.equal(nebulaImage.headers.get("content-type"), "image/jpeg");
    assert.match(nebulaImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await nebulaImage.arrayBuffer()).byteLength > 100_000);
    const orbitImage = await fetch(`${address.url}themes/orbit/orbit-cartography.jpg`);
    assert.equal(orbitImage.status, 200);
    assert.equal(orbitImage.headers.get("content-type"), "image/jpeg");
    assert.match(orbitImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await orbitImage.arrayBuffer()).byteLength > 100_000);
    const orbitMark = await fetch(`${address.url}themes/orbit/orbit-mark.png`);
    assert.equal(orbitMark.status, 200);
    assert.equal(orbitMark.headers.get("content-type"), "image/png");
    assert.match(orbitMark.headers.get("cache-control"), /immutable/u);
    assert.ok((await orbitMark.arrayBuffer()).byteLength > 1_000);
    const meadow = await fetch(`${address.url}themes/meadow/meadow-sun.jpg`);
    assert.equal(meadow.status, 200);
    assert.equal(meadow.headers.get("content-type"), "image/jpeg");
    assert.match(meadow.headers.get("cache-control"), /immutable/u);
    assert.ok((await meadow.arrayBuffer()).byteLength > 100_000);
    /* Дополнительные сцены Verdant живут в том же пакете и публикуются
       автоматически вместе с его манифестом. */
    for (const name of ["verdant-canopy.jpg", "verdant-sanctum.jpg"]) {
      const scene = await fetch(`${address.url}themes/verdant/${name}`);
      assert.equal(scene.status, 200, name);
      assert.equal(scene.headers.get("content-type"), "image/jpeg", name);
      assert.match(scene.headers.get("cache-control"), /immutable/u, name);
      assert.ok((await scene.arrayBuffer()).byteLength > 100_000, name);
    }
    /* Эмблема вырезана из согласованного концепта и остаётся ресурсом самой
       темы, поэтому сервер и Worker находят её без общего списка ассетов. */
    const verdantMark = await fetch(`${address.url}themes/verdant/verdant-mark.png`);
    assert.equal(verdantMark.status, 200);
    assert.equal(verdantMark.headers.get("content-type"), "image/png");
    assert.match(verdantMark.headers.get("cache-control"), /immutable/u);
    assert.ok((await verdantMark.arrayBuffer()).byteLength > 100);
    /* Летний кадр и акварель «Озера» остаются JPEG: в PNG они весили бы
       впятеро больше при том же виде. */
    for (const name of [
      "lake-summer.jpg", "lake-watercolor.jpg",
      "gothic-tower.jpg", "gothic-harbor.jpg", "gothic-chapel.jpg", "gothic-keep.jpg",
      "gothic-minental-castle.jpg", "gothic-minental-fortress.jpg", "gothic-finkregh.jpg",
    ]) {
      const theme = name.startsWith("lake-") ? "lake" : "gothic";
      const lake = await fetch(`${address.url}themes/${theme}/${name}`);
      assert.equal(lake.status, 200, name);
      assert.equal(lake.headers.get("content-type"), "image/jpeg", name);
      assert.match(lake.headers.get("cache-control"), /immutable/u, name);
      assert.ok((await lake.arrayBuffer()).byteLength > 100_000, name);
    }
    /* Сцены и палитра темы приходят из одной автоматически найденной папки. */
    const backgrounds = await fetch(`${address.url}themes/lake/theme.css`);
    assert.equal(backgrounds.status, 200);
    assert.match(backgrounds.headers.get("content-type"), /text\/css/u);
    const lakeStyles = await backgrounds.text();
    assert.match(lakeStyles, /\[data-background="lake-summer"\]/u);
    assert.match(lakeStyles, /\[data-background="lake-watercolor"\]/u);
    assert.doesNotMatch(lakeStyles, /lake-oil/u);
    const lakeAfterRain = await fetch(`${address.url}themes/lake/lake-after-rain.jpg`);
    assert.equal(lakeAfterRain.status, 200);
    assert.equal(lakeAfterRain.headers.get("content-type"), "image/jpeg");
    assert.match(lakeAfterRain.headers.get("cache-control"), /immutable/u);
    assert.ok((await lakeAfterRain.arrayBuffer()).byteLength > 100_000);
    const lakeCorners = await fetch(`${address.url}themes/lake/lake-corners.png`);
    assert.equal(lakeCorners.status, 200);
    assert.equal(lakeCorners.headers.get("content-type"), "image/png");
    assert.match(lakeCorners.headers.get("cache-control"), /immutable/u);
    for (const asset of ["lake-mark.png", "lake-settings.png"]) {
      const lakeChrome = await fetch(`${address.url}themes/lake/${asset}`);
      assert.equal(lakeChrome.status, 200);
      assert.equal(lakeChrome.headers.get("content-type"), "image/png");
      assert.match(lakeChrome.headers.get("cache-control"), /immutable/u);
    }
    const verdantStyles = await fetch(`${address.url}themes/verdant/theme.css`);
    assert.equal(verdantStyles.status, 200);
    assert.match(verdantStyles.headers.get("content-type"), /text\/css/u);
    assert.match(await verdantStyles.text(), /\[data-background="verdant-sanctum"\]/u);
    const storm = await fetch(`${address.url}themes/stormglass/storm-sea.jpg`);
    assert.equal(storm.status, 200);
    assert.equal(storm.headers.get("content-type"), "image/jpeg");
    assert.match(storm.headers.get("cache-control"), /immutable/u);
    assert.ok((await storm.arrayBuffer()).byteLength > 100_000);
    const magma = await fetch(`${address.url}themes/magma/magma-crust.jpg`);
    assert.equal(magma.status, 200);
    assert.equal(magma.headers.get("content-type"), "image/jpeg");
    assert.match(magma.headers.get("cache-control"), /immutable/u);
    assert.ok((await magma.arrayBuffer()).byteLength > 100_000);
    const pulsar = await fetch(`${address.url}themes/pulsar/pulsar-beams.jpg`);
    assert.equal(pulsar.status, 200);
    assert.equal(pulsar.headers.get("content-type"), "image/jpeg");
    assert.match(pulsar.headers.get("cache-control"), /immutable/u);
    const taiga = await fetch(`${address.url}themes/taiga/rainforest-night.jpg`);
    assert.equal(taiga.status, 200);
    assert.equal(taiga.headers.get("content-type"), "image/jpeg");
    assert.match(taiga.headers.get("cache-control"), /immutable/u);
    const metropolis = await fetch(`${address.url}themes/metropolis/metropolis-night.jpg`);
    assert.equal(metropolis.status, 200);
    assert.equal(metropolis.headers.get("content-type"), "image/jpeg");
    assert.match(metropolis.headers.get("cache-control"), /immutable/u);
    assert.ok((await metropolis.arrayBuffer()).byteLength > 100_000);
    const stormGlass = await fetch(`${address.url}themes/stormglass/storm-sea.jpg`);
    assert.equal(stormGlass.status, 200);
    assert.equal(stormGlass.headers.get("content-type"), "image/jpeg");
    assert.match(stormGlass.headers.get("cache-control"), /immutable/u);
    assert.ok((await stormGlass.arrayBuffer()).byteLength > 100_000);
    const reliquary = await fetch(`${address.url}themes/reliquary/ashen-reliquary.jpg`);
    assert.equal(reliquary.status, 200);
    assert.equal(reliquary.headers.get("content-type"), "image/jpeg");
    assert.match(reliquary.headers.get("cache-control"), /immutable/u);
    assert.ok((await reliquary.arrayBuffer()).byteLength > 100_000);
    assert.ok((await blackHole.arrayBuffer()).byteLength > 100_000);
    assert.ok((await taiga.arrayBuffer()).byteLength > 100_000);
    assert.ok((await pulsar.arrayBuffer()).byteLength > 100_000);
    const page = await (await fetch(address.url)).text();
    assert.match(page, /data-theme="orbit"/u);
    assert.match(page, /<option value="taiga">Rain<\/option>/u);
    assert.match(page, /data-panel-open="settings"/u);
    assert.match(page, /data-view-button="statistics"/u);
    assert.match(page, /data-comparison-chart/u);
    assert.match(page, /data-comparison-summary/u);
    assert.match(page, /data-usage-unit="pte"/u);
    assert.match(page, /data-toggle="includeClaudeUsage"/u);
    assert.match(page, /data-claude-group-toggle/u);
    assert.match(page, /data-token-breakdown-toggle/u);
    assert.match(page, /data-trusted-device-list/u);
    assert.match(page, /data-device-create/u);
    assert.match(page, /<option value="metropolis">Мегаполис<\/option>/u);
    assert.match(page, /data-metropolis-glass/u);
    assert.match(page, /\/themes\/metropolis\/theme\.css/u);
    assert.match(page, /\/themes\/stormglass\/storm-glass\.js/u);
    assert.match(page, /data-theme-catalog/u);
    assert.match(page, /<option value="magma">Магма<\/option>/u);
    assert.match(page, /<option value="stormglass">Storm<\/option>/u);
    assert.match(page, /<option value="meadow">Луг<\/option>/u);
    assert.match(page, /<option value="lake">Озеро<\/option>/u);
    assert.match(page, /data-surface="desktop"/u);
    assert.match(page, /data-theme-select/u);
    assert.match(page, /data-collapse-all/u);
    assert.doesNotMatch(page, /data-rate-limits-slot/u);
    assert.equal(page.match(/data-current-limits=/gu)?.length, 2);
    assert.ok(page.indexOf("data-collapse-all") < page.indexOf("data-theme-select"));
    assert.doesNotMatch(page, /data-connection|Автообновление/u);
    assert.match(page, /<option value="graphite">Графит<\/option>/u);
    assert.match(page, /<option value="reliquary">Пепельный реликварий<\/option>/u);
    assert.match(page, /data-group-select/u);
    assert.match(page, /<option value="date">По дням<\/option>/u);
    assert.match(page, /<option value="week">По неделям<\/option>/u);
    assert.match(page, /<option value="month">По месяцам<\/option>/u);
    assert.match(page, /<option value="task">По задачам<\/option>/u);
    assert.match(page, />Орбита</u);
    assert.match(page, />Туманность</u);
    assert.match(page, />Пульсар</u);
    assert.match(page, />Gothic</u);
    assert.match(page, /<img data-app-mark src="\/agent-hub-mark\.png"/u);
    assert.match(page, /<link rel="icon" type="image\/png" href="\/agent-hub-mark\.png">/u);
    for (const icon of [
      "chats-circle",
      "notebook",
      "arrow-clockwise",
      "plus",
      "magnifying-glass",
      "chat-centered-text",
      "caret-left",
      "stop",
      "git-diff",
      "sliders-horizontal",
      "paperclip",
      "paper-plane-right",
      "list-checks",
      "x",
      "arrows-clockwise",
      "corners-out",
    ]) {
      assert.match(page, new RegExp(`data-phosphor-icon="${icon}"`, "u"), icon);
    }
    assert.match(page, /data-action="annotate-selection"/u);
    assert.doesNotMatch(page, /data-action="annotate"/u);
    const script = await (await fetch(`${address.url}app.js`)).text();
    assert.match(script, /agent-hub-theme/u);
    assert.match(script, /function readThemeCatalog/u);
    assert.match(script, /themeCatalog\.map\(\(theme\) => \[theme\.id, theme\.color\]\)/u);
    assert.match(
      script,
      /SERVER_CONFIG_LEFT_KEYS[\s\S]*?"autoApproveOnStart"[\s\S]*?"codexSandboxMode"[\s\S]*?"guardConcurrentRepositoryWrites"/u,
    );
    assert.match(
      script,
      /SERVER_CONFIG_RIGHT_KEYS[\s\S]*?"contextAutomation\.autoCompactAfterTurn"[\s\S]*?"contextAutomation\.autoRotateAfterCompaction"[\s\S]*?"components\.codexContextCleanup"/u,
    );
    assert.match(
      script,
      /SERVER_CONFIG_ADVANCED_COLUMNS[\s\S]*?"codexRolloutContext\.scanIntervalSeconds", "codexRpcTimeoutSeconds"[\s\S]*?"deferredInputTtlHours", "progressStartDelayMs"[\s\S]*?"deliveryRetryIntervalSeconds", "logMaxFiles"/u,
    );
    assert.match(script, /Странные константы, трогать не рекомендую/u);
    assert.match(script, /server-config-switch-control[\s\S]*?switch-track[\s\S]*?switch-text/u);
    assert.match(script, /entry\.presentation === "access-toggle"/u);
    assert.match(script, /input\.checked \? "danger-full-access" : "workspace-write"/u);
    assert.match(script, /background\.particles/u);
    assert.match(page, /"id":"metropolis","name":"Мегаполис","color":"#050b12"/u);
    assert.match(page, /"aliases":\["taiga-drops"\]/u);
    assert.match(script, /agent-hub-grouping/u);
    assert.match(script, /document\.documentElement\.dataset\.theme/u);
    assert.match(script, /document\.documentElement\.dataset\.grouping/u);
    assert.match(script, /function taskGroupingContent/u);
    assert.match(script, /workLogTurnDurationSeconds/u);
    assert.match(script, /durationLabel\.textContent = "Длит\."/u);
    assert.match(script, /workLogTurnCredits/u);
    assert.match(script, /creditsLabel\.textContent = "Итого"/u);
    assert.match(script, /agent-hub-token-breakdown/u);
    assert.match(script, /function applyBreakdown/u);
    assert.match(script, /function comparisonSeriesPicker/u);
    assert.match(script, /data-comparison-series-select/u);
    assert.match(page, /data-stream-collapse-toggle/u);
    assert.doesNotMatch(page, /data-workspace-collapse-toggle/u);
    assert.match(page, /Сворачивать все потоки/u);
    assert.match(script, /agent-hub-collapse-streams/u);
    assert.match(script, /function applyStreamCollapse/u);
    assert.match(script, /function setStreamsCollapsed/u);
    assert.match(script, /function upgradeLegacyWorkspaceGroups/u);
    assert.match(script, /details\[data-work-log-workspace\]\[open\]/u);
    assert.match(script, /details\[data-work-log-stream\]\[open\]/u);
    assert.match(script, /function decorateLegacyStreamTurns/u);
    assert.match(script, /function taskProfile/u);
    assert.match(script, /\.workLogTaskProfile/u);
    assert.match(script, /Профиль задачи/u);
    assert.match(script, /label: "Навыки"/u);
    assert.match(script, /label: "MCP"/u);
    assert.match(script, /workLogTurnMcpCalls/u);
    assert.match(script, /function taskProfileAccordion/u);
    assert.match(script, /workLogTaskProfileDetailContent/u);
    assert.match(script, /\.dataset\.radarTooltip/u);
    assert.match(script, /data-radar-hit/u);
    assert.match(script, /pointerenter/u);
    assert.match(
      script,
      /telegramMode && mobileTelegramPlatforms\.has\(telegramPlatform\)/u,
    );
    assert.match(script, /layoutViewportWidth\(\) < compactSurfaceWidth/u);
    assert.doesNotMatch(script, /return window\.innerWidth < compactSurfaceWidth/u);
    assert.doesNotMatch(script, /if \(!telegramMode\) return "desktop"/u);
    assert.match(script, /class: "task-runtime"/u);
    assert.match(script, /if \(sameData\(state\.live\.get\(taskId\)/u);
    assert.match(script, /data-phosphor-icon="speaker-high"/u);

    const hubClient = await (await fetch(`${address.url}hub-client.js`)).text();
    assert.match(hubClient, /hub: "HUB"/u);
    assert.match(hubClient, /telegram: "HUB"/u);
    assert.match(hubClient, /desktop: "APP"/u);
    assert.match(hubClient, /cli: "CLI"/u);
    assert.match(hubClient, /pendingSelectionId/u);
    assert.match(hubClient, /history\.replaceState/u);
    assert.match(hubClient, /task\.run\?\.model \?\? task\.model/u);
    assert.doesNotMatch(hubClient, /location\.hash\s*=/u);
    assert.match(script, /document\.documentElement\.dataset\.surface = surface/u);
    assert.match(script, /telegram\?\.expand\(\)/u);
    assert.match(page, /data-telegram-fullscreen hidden/u);
    assert.match(script, /telegramFullscreenButton\?\.addEventListener\("click"/u);
    assert.match(script, /telegram\?\.requestFullscreen\?\.\(\)/u);
    assert.match(script, /telegram\?\.exitFullscreen\?\.\(\)/u);
    assert.match(script, /headers\["If-None-Match"\]/u);
    assert.match(script, /response\.status === 304/u);
    assert.match(script, /closest\("\[data-work-log-collapse-turns\]"\)/u);
    assert.match(script, /row\?\.querySelector\("details\[data-work-log-previous-turns\]"\)/u);
    assert.match(script, /window\.addEventListener\("resize", syncSurface\)/u);
    assert.match(script, /data-mobile-expanded/u);
    assert.match(script, /data-mobile-open/u);
    assert.match(script, /button\.hidden = hidden/u);
    assert.match(script, /collapse && surface !== "mobile"/u);
    assert.match(script, /journalRendered/u);
    assert.match(script, /details\[data-work-log-day-section\]\[open\]/u);
    assert.match(script, /collapseAllButton\.addEventListener/u);
    assert.match(script, /agent-hub:journal-open-state:v1/u);
    assert.match(script, /localStorage\.setItem\(OPEN_STATE_KEY/u);
    assert.match(script, /localStorage\.getItem\(OPEN_STATE_KEY\)/u);
    assert.match(script, /persistOpenState\(\)/u);
    assert.match(script, /\/api\/journal\/day/u);
    assert.match(script, /\/api\/journal\/turn/u);
    assert.match(script, /data-lazy-day/u);
    assert.match(script, /data-lazy-turn-id/u);
    const themeIds = [
      "orbit", "nebula", "pulsar", "gothic", "blackhole", "taiga", "metropolis",
      "stormglass", "magma", "meadow", "lake", "graphite", "reliquary",
    ];
    const styles = [
      await (await fetch(`${address.url}styles.css`)).text(),
      ...await Promise.all(themeIds.map(async (theme) => (
        (await (await fetch(`${address.url}themes/${theme}/theme.css`)).text())
          .replaceAll('url("./', 'url("/')
      ))),
    ].join("\n");
    assert.match(styles, /html\[data-theme="nebula"\]/u);
    assert.match(styles, /html\[data-theme="pulsar"\]/u);
    assert.match(styles, /html\[data-theme="gothic"\]/u);
    assert.match(styles, /url\("\/blackhole-blue\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="taiga"\]/u);
    assert.match(styles, /html\[data-theme="metropolis"\] body::after/u);
    assert.match(styles, /url\("\/metropolis-night\.jpg"\)/u);
    assert.match(styles, /url\("\/storm-sea\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="stormglass"\]/u);
    const glass = await (await fetch(`${address.url}themes/metropolis/metropolis-glass.js`)).text();
    assert.match(glass, /vec4 rainLayer/u);
    assert.match(glass, /uniform sampler2D uFogImage/u);
    assert.match(glass, /function createFogTexture/u);
    assert.match(styles, /url\("\/pulsar-beams\.jpg"\)/u);
    assert.match(styles, /url\("\/magma-crust\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="magma"\]/u);
    assert.match(styles, /url\("\/meadow-sun\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="meadow"\]/u);
    assert.match(styles, /url\("\/lake-after-rain\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="lake"\]/u);
    assert.match(styles, /url\("\/gothic-concrete\.jpg"\)/u);
    assert.match(styles, /url\("\/nebula-veil\.jpg"\)/u);
    assert.match(styles, /url\("\/orbit-cartography\.jpg"\)/u);
    assert.match(styles, /url\("\/orbit-mark\.png"\)/u);
    assert.match(styles, /html\[data-theme="graphite"\]/u);
    assert.match(styles, /html\[data-theme="reliquary"\]/u);
    assert.match(styles, /\.server-config-primary\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
    assert.match(styles, /\.server-config-column\s*\{[\s\S]*?grid-template-rows: subgrid/u);
    assert.match(styles, /\.server-config-inline-value\s*\{[\s\S]*?padding-left: 2\.97rem/u);
    assert.match(styles, /\.server-config-advanced-grid\s*\{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u);
    assert.match(styles, /html\[data-surface="mobile"\] \.server-config-primary\s*\{[\s\S]*?display: flex/u);
    assert.match(styles, /html\[data-surface="mobile"\] \.server-config-advanced-grid\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/u);
    assert.match(styles, /url\("\/ashen-reliquary\.jpg"\)/u);
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?html\[data-theme="reliquary"\] body::before/u);
    assert.match(styles, /--ph-mask-caret-right:/u);
    assert.match(styles, /--ph-mask-caret-double-up:/u);
    assert.match(
      styles,
      /\.chat-overlay-actions > \.chip-button \{[\s\S]*?height: 2\.1rem;[\s\S]*?padding-block: 0;/u,
    );
    assert.match(
      styles,
      /html\[data-surface="mobile"\] \.chat-overlay-actions \{[\s\S]*?z-index: 21;/u,
    );
    assert.match(
      styles,
      /html\[data-surface="mobile"\]\[data-theme\] \.dialog-settings \{[\s\S]*?backdrop-filter: none;[\s\S]*?background: var\(--bg\);/u,
    );
    assert.match(
      styles,
      /\.composer-main > \.chip-button \{[\s\S]*?height: 2\.4rem;[\s\S]*?padding-block: 0;/u,
    );
    assert.doesNotMatch(styles, /content:\s*"[▶▼▸▾⌃]"/u);
    assert.doesNotMatch(
      styles,
      /html\[data-theme="graphite"\] \.brand-mark svg\s*\{[^}]*display:\s*none/u,
    );
    assert.doesNotMatch(
      styles,
      /html\[data-theme="graphite"\] \.brand-mark::after\s*\{/u,
    );
    assert.match(
      styles,
      /html\[data-theme="graphite"\][\s\S]*?span\[data-kilo-usage\][\s\S]*?background: transparent;[\s\S]*?color: oklch\(0\.88 0\.003 260\) !important;/u,
    );
    assert.match(
      styles,
      /html\[data-theme="graphite"\] \.journal summary\[data-task-usage\] \{[\s\S]*?background: transparent;[\s\S]*?border-color: transparent;[\s\S]*?border-radius: 0;[\s\S]*?color: var\(--text-faint\);/u,
    );
    assert.match(
      styles,
      /summary\[data-task-usage\] > \[data-usage-label\] \{[\s\S]*?font-size: 0\.64rem;[\s\S]*?letter-spacing: var\(--label-spacing\);[\s\S]*?text-transform: var\(--label-transform\);/u,
    );
    assert.match(styles, /url\("\/rainforest-night\.jpg"\)/u);
    assert.match(styles, /details\[data-work-log-task-group\]/u);
    assert.match(styles, /summary\[data-work-log-workspace-header\]/u);
    assert.match(styles, /grid-template-columns: 1rem 17\.5rem minmax\(0, 1fr\)/u);
    assert.match(styles, /summary\[data-work-log-stream-summary\]/u);
    assert.match(styles, /span\[data-work-log-stream-title\] button\[data-open-task\]/u);
    assert.match(styles, /\[data-work-log-task-duration\]/u);
    assert.match(styles, /\[data-work-log-task-credits\]/u);
    assert.match(styles, /\[data-work-log-task-profile\]/u);
    assert.match(styles, /\[data-work-log-task-profile-detail\]/u);
    assert.match(styles, /\[data-work-log-task-profile-detail-items\]/u);
    assert.match(styles, /\[data-radar-current\]/u);
    assert.match(styles, /\[data-radar-tooltip\]/u);
    assert.match(styles, /html\[data-grouping="task"\]/u);
    assert.match(styles, /html\[data-surface="mobile"\] \.journal div\[data-work-log-row\]/u);
    assert.match(styles, /span\[data-day-usage-table\]\[data-mobile-expanded\]/u);
    assert.match(styles, /div\[data-work-log-row\]\[data-mobile-open\]/u);
    assert.match(styles, /button\[data-work-log-collapse-turns\]/u);
    assert.match(
      styles,
      /\.journal div\[data-work-log-turn-files\]\s*\{\s*display: none;/u,
    );
    assert.match(
      styles,
      /button\[data-work-log-collapse-turns\]\[hidden\][\s\S]*display: none !important/u,
    );
    assert.match(
      styles,
      /grid-template-columns: auto minmax\(3\.15rem, 1fr\) 7\.4ch 5ch/u,
    );
    assert.match(styles, /"Palatino Linotype"/u);
    assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) 8\.6ch 6ch/u);
    assert.equal((await fetch(`${address.url}missing`)).status, 404);
    assert.equal((await fetch(`${address.url}`, { method: "POST" })).status, 405);

    const events = await fetch(`${address.url}events`, { signal: abort.signal });
    assert.equal(events.status, 200);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    while (!stream.includes("event: ready")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      stream += decoder.decode(chunk.value, { stream: true });
    }

    journalDatabase.replace(`${DAY_HTML}\n<!-- changed -->`);
    const deadline = Date.now() + 2_000;
    while (!stream.includes("event: journal") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 2_000)),
      ]);
      assert.equal(chunk.done, false);
      stream += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(stream, /event: journal/u);
  } finally {
    abort.abort();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App forwards authenticated control commands to Agent Hub", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-control-"));
  const attachmentDirectory = path.join(directory, "attachments");
  const calls = [];
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    attachmentDirectory,
    controlHandler: async (request) => {
      calls.push(request);
      return { generatedAt: "now" };
    },
  });
  try {
    const address = await server.start();
    const local = await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "snapshot", params: { refresh: true } }),
    });
    assert.equal(local.status, 200);
    assert.deepEqual(await local.json(), {
      ok: true,
      result: { generatedAt: "now" },
    });
    assert.deepEqual(calls, [{
      action: "snapshot",
      params: { refresh: true },
      context: { source: "local-mini-app" },
    }]);

    const externalHeaders = {
      "CF-Connecting-IP": "203.0.113.10",
      "Content-Type": "application/json",
    };
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: externalHeaders,
      body: JSON.stringify({ action: "snapshot", params: {} }),
    })).status, 401);
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        ...externalHeaders,
        Authorization: `tma ${signedInitData()}`,
      },
      body: JSON.stringify({ action: "snapshot", params: {} }),
    })).status, 200);
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "GET",
    })).status, 405);

    const imageBody = Buffer.from("fake-png");
    const upload = await fetch(`${address.url}api/attachment`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: imageBody,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(path.dirname(uploaded.path), attachmentDirectory);
    assert.deepEqual(await readFile(uploaded.path), imageBody);
    const documentUpload = await fetch(`${address.url}api/attachment`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Agent-Hub-File-Name": encodeURIComponent("заметки.txt"),
      },
      body: "plain text",
    });
    assert.equal(documentUpload.status, 201);
    const uploadedDocument = await documentUpload.json();
    assert.equal(uploadedDocument.attachment.name, "заметки.txt");
    assert.equal(uploadedDocument.attachment.type, "text/plain");
    assert.deepEqual(await readFile(uploadedDocument.path, "utf8"), "plain text");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted Android device session is independent of Telegram user ids", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-auth-"));
  const deviceStore = {
    async resolveSession(token) {
      assert.equal(token, "device-session-token");
      return { id: "local-owner", deviceId: "device-id" };
    },
  };
  let receivedContext = null;
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    allowedUserIds: new Set([42]),
    deviceStore,
    controlHandler: async ({ context }) => {
      receivedContext = context;
      return { connected: true };
    },
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        Authorization: "device device-session-token",
        "CF-Connecting-IP": "203.0.113.10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "snapshot", params: {} }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      result: { connected: true },
    });
    assert.deepEqual(receivedContext, {
      source: "trusted-device",
      userId: "local-owner",
      deviceId: "device-id",
    });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public device authentication endpoints are rate limited per client", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-rate-limit-"));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    requireTelegramAuth: true,
    deviceStore: {
      async pair() { throw new Error("invalid pairing code"); },
      async createChallenge() { throw new Error("invalid device id"); },
      async createSession() { throw new Error("invalid device challenge"); },
    },
  });
  try {
    const address = await server.start();
    const request = () => fetch(`${address.url}api/device/pair`, {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.44",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    for (let index = 0; index < 30; index += 1) {
      assert.equal((await request()).status, 400);
    }
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.match(String(limited.headers.get("retry-after")), /^\d+$/u);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public authentication limiter stays bounded under many distinct client IPs", () => {
  const limiter = new PublicAuthAttemptLimiter({ capacity: 3, limit: 2, windowMs: 60_000 });
  const startedAt = Date.parse("2026-08-02T12:00:00.000Z");
  assert.equal(limiter.consume("203.0.113.1", startedAt).allowed, true);
  assert.equal(limiter.consume("203.0.113.1", startedAt + 1).allowed, true);
  assert.equal(limiter.consume("203.0.113.1", startedAt + 2).allowed, false);

  for (let index = 2; index <= 40; index += 1) {
    assert.equal(limiter.consume(`203.0.113.${index}`, startedAt + index).allowed, true);
    assert.ok(limiter.size <= 3);
  }

  // The original IP was evicted by the fixed-capacity LRU, while each retained
  // client still has its own independent counter.
  assert.equal(limiter.consume("203.0.113.40", startedAt + 100).allowed, true);
  assert.equal(limiter.consume("203.0.113.40", startedAt + 101).allowed, false);
  assert.equal(limiter.consume("203.0.113.1", startedAt + 102).allowed, true);
  assert.equal(limiter.size, 3);

  // Expiry is handled on the touched bucket without scanning the rest of the
  // Map, and starts a new rate-limit window for that address.
  assert.equal(limiter.consume("203.0.113.40", startedAt + 60_100).allowed, true);
  assert.ok(limiter.size <= 3);
});

test("local Mini App requires a protected session and rejects CSRF-shaped control requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-local-auth-"));
  const localAccessSecret = "a".repeat(43);
  let calls = 0;
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    localAccessSecret,
    controlHandler: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  try {
    const address = await server.start();
    const request = { action: "snapshot", params: {} };
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(request),
    })).status, 401);
    assert.equal(calls, 0);

    const session = await fetch(`${address.url}api/local-session`, {
      method: "POST",
      headers: {
        Authorization: `local ${localAccessSecret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const cookie = String(session.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.match(cookie, /^agent_hub_local=/u);

    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(request),
    })).status, 415);
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    })).status, 200);
    assert.equal(calls, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Mini App reloads a rotated access secret without a server restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-local-secret-rotation-"));
  const secretFile = path.join(directory, "local-web.secret");
  const initialSecret = "a".repeat(43);
  const rotatedSecret = "b".repeat(43);
  await writeFile(secretFile, `${initialSecret}\n`, "utf8");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    localAccessSecret: initialSecret,
    localAccessSecretFile: secretFile,
  });
  try {
    const address = await server.start();
    await writeFile(secretFile, `${rotatedSecret}\n`, "utf8");
    const session = await fetch(`${address.url}api/local-session`, {
      method: "POST",
      headers: {
        Authorization: `local ${rotatedSecret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(session.status, 200);
    assert.match(String(session.headers.get("set-cookie") ?? ""), /^agent_hub_local=/u);
    assert.equal((await fetch(`${address.url}api/local-session`, {
      method: "POST",
      headers: {
        Authorization: `local ${initialSecret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    })).status, 403);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App serves old days and turn bodies through lazy endpoints", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-lazy-"));
  const days = Array.from({ length: 6 }, (_, index) => {
    const day = String(6 - index).padStart(2, "0");
    const turnId = `turn-${day}`;
    return [
      "<details data-work-log-day-section>",
      `<summary data-work-log-day><strong>${day}.07.2026</strong></summary>`,
      `<div data-work-log-turn-entry data-work-log-turn-id="${turnId}">`,
      "<details data-work-log-turn-details>",
      `<summary>Ход ${turnId}</summary>`,
      `<div data-work-log-turn-expanded><div>Запрос ${turnId}</div><div>Ответ ${turnId}</div></div>`,
      "</details></div></details>",
    ].join("");
  });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(days.join("\n")),
  });
  try {
    const address = await server.start();
    const index = await (await fetch(`${address.url}api/journal`)).json();
    assert.match(index.html, /data-lazy-day="01\.07\.2026"/u);
    assert.doesNotMatch(index.html, /Ответ turn-01/u);

    const dayResponse = await fetch(
      `${address.url}api/journal/day?date=01.07.2026&version=${encodeURIComponent(index.version)}`,
    );
    assert.equal(dayResponse.status, 200);
    const day = await dayResponse.json();
    assert.match(day.html, /Ход turn-01/u);
    assert.doesNotMatch(day.html, /Ответ turn-01/u);

    const turnResponse = await fetch(
      `${address.url}api/journal/turn?id=turn-01&version=${encodeURIComponent(index.version)}`,
    );
    assert.equal(turnResponse.status, 200);
    assert.match((await turnResponse.json()).html, /Ответ turn-01/u);

    assert.equal((await fetch(
      `${address.url}api/journal/day?date=01.07.2026&version=old`,
    )).status, 409);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App can require Telegram authorization on a dedicated public listener", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-public-mini-app-"));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    requireTelegramAuth: true,
  });
  try {
    const address = await server.start();
    assert.equal((await fetch(`${address.url}health`)).status, 200);
    assert.equal((await fetch(`${address.url}api/journal`)).status, 401);
    assert.equal((await fetch(`${address.url}api/journal`, {
      headers: { Authorization: `tma ${signedInitData()}` },
    })).status, 200);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate-limit summary is served apart from the lazy journal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-mini-app-"));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(`${LIMITS_HTML}\n${DAY_HTML}`),
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/rate-limits`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.html, /data-work-log-rate-limits/u);
    assert.match(payload.html, /CODEX/u);
    assert.equal(payload.sampledAt, "2026-07-30T02:55:14.512Z");
    // шапке нужен только блок: полный журнал весит на три порядка больше
    assert.ok(payload.html.length < 1_000);
    assert.doesNotMatch(payload.html, /data-work-log-day-section/u);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate-limit endpoint answers with an empty summary when the journal has none", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-no-limits-mini-app-"));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
  });
  try {
    const address = await server.start();
    const payload = await (await fetch(`${address.url}api/rate-limits`)).json();
    assert.equal(payload.html, "");
    assert.equal(payload.sampledAt, "");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Android update manifest and APK are served from one bounded runtime artifact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mobile-update-"));
  const updateDirectory = path.join(directory, "mobile");
  const apk = Buffer.from("signed-apk-fixture");
  const sha256 = createHash("sha256").update(apk).digest("hex");
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(path.join(updateDirectory, "AgentHub-Mobile.apk"), apk);
  await writeFile(path.join(updateDirectory, "update.json"), JSON.stringify({
    versionCode: 2,
    versionName: "0.2.0",
    sha256,
    bytes: apk.length,
  }));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
    mobileUpdateDirectory: updateDirectory,
  });
  try {
    const address = await server.start();
    const manifestResponse = await fetch(`${address.url}api/mobile/update`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("cache-control"), /no-store/u);
    assert.deepEqual(await manifestResponse.json(), {
      versionCode: 2,
      versionName: "0.2.0",
      sha256,
      bytes: apk.length,
      downloadUrl: "/api/mobile/update.apk",
    });
    const apkResponse = await fetch(`${address.url}api/mobile/update.apk`);
    assert.equal(apkResponse.status, 200);
    assert.equal(apkResponse.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.deepEqual(Buffer.from(await apkResponse.arrayBuffer()), apk);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
