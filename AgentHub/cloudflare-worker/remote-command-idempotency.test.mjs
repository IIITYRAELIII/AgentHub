import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

async function loadRemoteCommandState() {
  const source = await readFile(path.join(here, "remote-command-idempotency.js"), "utf8");
  const context = { Request, Response, TextEncoder, URL };
  vm.runInNewContext(source, context, { filename: "remote-command-idempotency.js" });
  return context.AgentHubRemoteCommandState;
}

test("remote command retries reuse one persisted id without storing request text", async () => {
  const api = await loadRemoteCommandState();
  const storage = new MemoryStorage();
  let now = Date.parse("2026-07-30T08:00:00.000Z");
  const firstClient = api.create({
    storage,
    cryptoImpl: webcrypto,
    now: () => now,
  });
  const params = { text: "Секретный текст", provider: "codex", threadId: "thread-1" };

  const first = await firstClient.acquire("send-message", params);
  const retry = await firstClient.acquire("send-message", params);
  assert.equal(retry.id, first.id);
  assert.doesNotMatch([...storage.values.values()].join(""), /Секретный текст/u);

  const reloadedClient = api.create({
    storage,
    cryptoImpl: webcrypto,
    now: () => now,
  });
  const afterReload = await reloadedClient.acquire("send-message", params);
  assert.equal(afterReload.id, first.id);

  assert.equal(reloadedClient.release(afterReload), true);
  const nextIntent = await reloadedClient.acquire("send-message", params);
  assert.notEqual(nextIntent.id, first.id);

  now += 26 * 60 * 1_000;
  const afterExpiry = await reloadedClient.acquire("send-message", params);
  assert.notEqual(afterExpiry.id, nextIntent.id);
});

test("remote command fetch retries replace fresh browser UUIDs with the persisted id", async () => {
  const api = await loadRemoteCommandState();
  const storage = new MemoryStorage();
  const state = api.create({ storage, cryptoImpl: webcrypto });
  const postedIds = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input, "https://hub.example.test/");
    if (url.pathname === "/api/control") {
      const payload = JSON.parse(init.body);
      postedIds.push(payload.commandId);
      return Response.json({ ok: true, pending: true, id: payload.commandId }, { status: 202 });
    }
    return Response.json({ ok: true, pending: false, result: { accepted: true } });
  };
  const wrappedFetch = api.installFetchInterceptor({ state, fetchImpl });
  const request = (commandId) => wrappedFetch("/api/control", {
    method: "POST",
    body: JSON.stringify({
      action: "send-message",
      params: { text: "Повтор" },
      commandId,
    }),
  });

  await request(webcrypto.randomUUID());
  await request(webcrypto.randomUUID());
  assert.equal(postedIds[1], postedIds[0]);

  await wrappedFetch(`/api/control/result?id=${postedIds[0]}`, { method: "GET" });
  await request(webcrypto.randomUUID());
  assert.notEqual(postedIds[2], postedIds[0]);
});
