import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractWorkLogHtml,
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
