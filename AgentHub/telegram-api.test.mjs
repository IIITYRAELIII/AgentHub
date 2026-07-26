import assert from "node:assert/strict";
import test from "node:test";
import { callTelegramJson, telegramBotApiUrl, telegramFileApiUrl } from "./telegram-api.mjs";

test("Telegram API URLs honor a custom base for JSON, media and downloads", () => {
  assert.equal(
    telegramBotApiUrl("http://127.0.0.1:8081/", "123:test", "/sendPhoto"),
    "http://127.0.0.1:8081/bot123:test/sendPhoto",
  );
  assert.equal(
    telegramFileApiUrl("http://127.0.0.1:8081/", "123:test", "/voice/file.ogg"),
    "http://127.0.0.1:8081/file/bot123:test/voice/file.ogg",
  );
});

test("callTelegramJson returns a successful Telegram result", async () => {
  let requestedUrl = "";
  const result = await callTelegramJson({
    token: "token",
    method: "sendMessage",
    body: { text: "ok" },
    apiBaseUrl: "http://127.0.0.1:9876/",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 7 },
      }), { status: 200 });
    },
  });
  assert.deepEqual(result, { message_id: 7 });
  assert.equal(requestedUrl, "http://127.0.0.1:9876/bottoken/sendMessage");
});

test("callTelegramJson marks rate limits as retryable and preserves Retry-After", async () => {
  await assert.rejects(
    callTelegramJson({
      token: "token",
      method: "sendMessage",
      body: {},
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        description: "Too Many Requests",
        parameters: { retry_after: 12 },
      }), { status: 429 }),
    }),
    (error) => error.retryable === true && error.retryAfterMs === 12_000,
  );
});

test("callTelegramJson distinguishes a nonretryable rejection from an uncertain network error", async () => {
  await assert.rejects(
    callTelegramJson({
      token: "token",
      method: "sendMessage",
      body: {},
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        description: "Bad Request",
      }), { status: 400 }),
    }),
    (error) => error.retryable === false && error.uncertain === false,
  );
  await assert.rejects(
    callTelegramJson({
      token: "token",
      method: "sendMessage",
      body: {},
      fetchImpl: async () => {
        throw new Error("connection reset");
      },
    }),
    (error) => error.retryable === true && error.uncertain === true,
  );
});
