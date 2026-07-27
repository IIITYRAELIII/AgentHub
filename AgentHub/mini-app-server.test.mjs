import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractWorkLogHtml, MiniAppServer } from "./mini-app-server.mjs";

const DAY_HTML = [
  '<details data-work-log-day-section open>',
  '<summary data-work-log-day><strong>27.07.2026</strong></summary>',
  '<div data-work-log-table>Пилот</div>',
  "</details>",
].join("");

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

test("Mini App serves the journal and announces WORK_LOG changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-"));
  const workLogFile = path.join(directory, "WORK_LOG.md");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    workLogFile,
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
