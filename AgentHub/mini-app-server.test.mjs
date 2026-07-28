import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractWorkLogHtml,
  miniAppMenuButtonRequests,
  MiniAppServer,
  validateTelegramInitData,
} from "./mini-app-server.mjs";

const DAY_HTML = [
  '<details data-work-log-day-section open>',
  '<summary data-work-log-day><strong>27.07.2026</strong></summary>',
  '<div data-work-log-table>Пилот</div>',
  "</details>",
].join("");
const BOT_TOKEN = "123456789:test-token";

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

test("Mini App serves the journal and announces WORK_LOG changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-"));
  const workLogFile = path.join(directory, "WORK_LOG.md");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    workLogFile,
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
  });
  const abort = new AbortController();
  try {
    await writeFile(workLogFile, `# Глобальный журнал работ\n\n${DAY_HTML}\n`, "utf8");
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
    assert.match(payload.version, /^\d+-\d+$/u);

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

    for (const pathname of ["", "app.js", "styles.css", "work-log.css"]) {
      const response = await fetch(`${address.url}${pathname}`);
      assert.equal(response.status, 200, pathname || "/");
      assert.ok((await response.text()).length > 20);
    }
    const blackHole = await fetch(`${address.url}blackhole-blue.png`);
    assert.equal(blackHole.status, 200);
    assert.equal(blackHole.headers.get("content-type"), "image/png");
    assert.match(blackHole.headers.get("cache-control"), /immutable/u);
    const storm = await fetch(`${address.url}storm-rain.png`);
    assert.equal(storm.status, 200);
    assert.equal(storm.headers.get("content-type"), "image/png");
    assert.match(storm.headers.get("cache-control"), /immutable/u);
    assert.ok((await storm.arrayBuffer()).byteLength > 100_000);
    const magma = await fetch(`${address.url}magma-crust.png`);
    assert.equal(magma.status, 200);
    assert.equal(magma.headers.get("content-type"), "image/png");
    assert.match(magma.headers.get("cache-control"), /immutable/u);
    assert.ok((await magma.arrayBuffer()).byteLength > 100_000);
    const pulsar = await fetch(`${address.url}pulsar-beams.png`);
    assert.equal(pulsar.status, 200);
    assert.equal(pulsar.headers.get("content-type"), "image/png");
    assert.match(pulsar.headers.get("cache-control"), /immutable/u);
    const taiga = await fetch(`${address.url}rainforest-night.png`);
    assert.equal(taiga.status, 200);
    assert.equal(taiga.headers.get("content-type"), "image/png");
    assert.match(taiga.headers.get("cache-control"), /immutable/u);
    assert.ok((await blackHole.arrayBuffer()).byteLength > 100_000);
    assert.ok((await taiga.arrayBuffer()).byteLength > 100_000);
    assert.ok((await pulsar.arrayBuffer()).byteLength > 100_000);
    const page = await (await fetch(address.url)).text();
    assert.match(page, /data-theme="orbit"/u);
    assert.match(page, /<option value="taiga">Тайга<\/option>/u);
    assert.match(page, /<option value="magma">Магма<\/option>/u);
    assert.match(page, /<option value="storm">Гроза<\/option>/u);
    assert.match(page, /data-surface="desktop"/u);
    assert.match(page, /data-theme-select/u);
    assert.match(page, />Орбита</u);
    assert.match(page, />Туманность</u);
    assert.match(page, />Пульсар</u);
    assert.match(page, />Gothic</u);
    const script = await (await fetch(`${address.url}app.js`)).text();
    assert.match(script, /agent-hub-theme/u);
    assert.match(script, /document\.documentElement\.dataset\.theme/u);
    assert.match(
      script,
      /telegramMode && mobileTelegramPlatforms\.has\(telegramPlatform\)/u,
    );
    assert.match(script, /window\.innerWidth < compactSurfaceWidth/u);
    assert.doesNotMatch(script, /if \(!telegramMode\) return "desktop"/u);
    assert.match(script, /document\.documentElement\.dataset\.surface = surface/u);
    assert.match(script, /telegram\?\.expand\(\)/u);
    assert.doesNotMatch(script, /requestFullscreen/u);
    assert.match(script, /closest\("\[data-work-log-collapse-turns\]"\)/u);
    assert.match(script, /row\?\.querySelector\("details\[data-work-log-previous-turns\]"\)/u);
    assert.match(script, /window\.addEventListener\("resize", syncSurface\)/u);
    assert.match(script, /data-mobile-expanded/u);
    assert.match(script, /data-mobile-open/u);
    assert.match(script, /button\.hidden = hidden/u);
    assert.match(script, /collapse && surface !== "mobile"/u);
    assert.match(script, /journalRendered/u);
    assert.match(script, /details\[data-work-log-day-section\]\[open\]/u);
    const styles = await (await fetch(`${address.url}styles.css`)).text();
    assert.match(styles, /html\[data-theme="nebula"\]/u);
    assert.match(styles, /html\[data-theme="pulsar"\]/u);
    assert.match(styles, /html\[data-theme="gothic"\]/u);
    assert.match(styles, /url\("\/blackhole-blue\.png"\)/u);
    assert.match(styles, /html\[data-theme="taiga"\]/u);
    assert.match(styles, /url\("\/pulsar-beams\.png"\)/u);
    assert.match(styles, /url\("\/magma-crust\.png"\)/u);
    assert.match(styles, /html\[data-theme="magma"\]/u);
    assert.match(styles, /url\("\/storm-rain\.png"\)/u);
    assert.match(styles, /html\[data-theme="storm"\]/u);
    assert.match(styles, /url\("\/rainforest-night\.png"\)/u);
    assert.match(styles, /html\[data-surface="mobile"\] \.journal div\[data-work-log-row\]/u);
    assert.match(styles, /span\[data-day-usage-table\]\[data-mobile-expanded\]/u);
    assert.match(styles, /div\[data-work-log-row\]\[data-mobile-open\]/u);
    assert.match(styles, /button\[data-work-log-collapse-turns\]/u);
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

    await writeFile(workLogFile, `# Глобальный журнал работ\n\n${DAY_HTML}\n<!-- changed -->\n`, "utf8");
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

test("Mini App can require Telegram authorization on a dedicated public listener", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-public-mini-app-"));
  const workLogFile = path.join(directory, "WORK_LOG.md");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    workLogFile,
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    requireTelegramAuth: true,
  });
  try {
    await writeFile(workLogFile, `# Глобальный журнал работ\n\n${DAY_HTML}\n`, "utf8");
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
