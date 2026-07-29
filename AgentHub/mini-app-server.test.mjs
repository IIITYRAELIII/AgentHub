import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    for (const pathname of ["", "app.js", "hub-client.js", "styles.css", "work-log.css"]) {
      const response = await fetch(`${address.url}${pathname}`);
      assert.equal(response.status, 200, pathname || "/");
      assert.ok((await response.text()).length > 20);
    }
    const blackHole = await fetch(`${address.url}blackhole-blue.png`);
    assert.equal(blackHole.status, 200);
    assert.equal(blackHole.headers.get("content-type"), "image/png");
    assert.match(blackHole.headers.get("cache-control"), /immutable/u);
    const gothicImage = await fetch(`${address.url}gothic-concrete.png`);
    assert.equal(gothicImage.status, 200);
    assert.equal(gothicImage.headers.get("content-type"), "image/png");
    assert.match(gothicImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await gothicImage.arrayBuffer()).byteLength > 100_000);
    const nebulaImage = await fetch(`${address.url}nebula-veil.png`);
    assert.equal(nebulaImage.status, 200);
    assert.equal(nebulaImage.headers.get("content-type"), "image/png");
    assert.match(nebulaImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await nebulaImage.arrayBuffer()).byteLength > 100_000);
    const orbitImage = await fetch(`${address.url}orbit-earth.png`);
    assert.equal(orbitImage.status, 200);
    assert.equal(orbitImage.headers.get("content-type"), "image/png");
    assert.match(orbitImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await orbitImage.arrayBuffer()).byteLength > 100_000);
    const meadow = await fetch(`${address.url}meadow-sun.png`);
    assert.equal(meadow.status, 200);
    assert.equal(meadow.headers.get("content-type"), "image/png");
    assert.match(meadow.headers.get("cache-control"), /immutable/u);
    assert.ok((await meadow.arrayBuffer()).byteLength > 100_000);
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
    assert.match(page, /<option value="meadow">Луг<\/option>/u);
    assert.match(page, /data-surface="desktop"/u);
    assert.match(page, /data-theme-select/u);
    assert.match(page, /data-collapse-all/u);
    assert.ok(page.indexOf("data-rate-limits-slot") < page.indexOf("data-collapse-all"));
    assert.ok(page.indexOf("data-collapse-all") < page.indexOf("data-theme-select"));
    assert.doesNotMatch(page, /data-connection|Автообновление/u);
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
    assert.match(script, /class: "task-runtime"/u);
    assert.match(script, /if \(sameData\(state\.live\.get\(taskId\)/u);

    const hubClient = await (await fetch(`${address.url}hub-client.js`)).text();
    assert.match(hubClient, /telegram: "HUB"/u);
    assert.match(hubClient, /desktop: "APP"/u);
    assert.match(hubClient, /cli: "CLI"/u);
    assert.match(hubClient, /pendingSelectionId/u);
    assert.match(hubClient, /history\.replaceState/u);
    assert.doesNotMatch(hubClient, /location\.hash\s*=/u);
    assert.match(script, /document\.documentElement\.dataset\.surface = surface/u);
    assert.match(script, /telegram\?\.expand\(\)/u);
    assert.doesNotMatch(script, /requestFullscreen/u);
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
    assert.match(styles, /url\("\/meadow-sun\.png"\)/u);
    assert.match(styles, /html\[data-theme="meadow"\]/u);
    assert.match(styles, /url\("\/gothic-concrete\.png"\)/u);
    assert.match(styles, /url\("\/nebula-veil\.png"\)/u);
    assert.match(styles, /url\("\/orbit-earth\.png"\)/u);
    assert.match(styles, /url\("\/rainforest-night\.png"\)/u);
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

test("Mini App forwards authenticated control commands to Agent Hub", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-control-"));
  const workLogFile = path.join(directory, "WORK_LOG.md");
  const attachmentDirectory = path.join(directory, "attachments");
  const calls = [];
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    workLogFile,
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    attachmentDirectory,
    controlHandler: async (request) => {
      calls.push(request);
      return { generatedAt: "now" };
    },
  });
  try {
    await writeFile(workLogFile, "# Журнал\n", "utf8");
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
    assert.equal((await fetch(`${address.url}api/attachment`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not an image",
    })).status, 400);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App serves old days and turn bodies through lazy endpoints", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-lazy-"));
  const workLogFile = path.join(directory, "WORK_LOG.md");
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
    workLogFile,
  });
  try {
    await writeFile(workLogFile, `# Журнал\n${days.join("\n")}\n`, "utf8");
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
