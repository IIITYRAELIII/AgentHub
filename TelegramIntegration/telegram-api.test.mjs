import assert from "node:assert/strict";
import test from "node:test";
import { callTelegramJson } from "./telegram-api.mjs";

test("callTelegramJson returns a successful Telegram result", async () => {
  const result = await callTelegramJson({
    token: "token",
    method: "sendMessage",
    body: { text: "ok" },
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      result: { message_id: 7 },
    }), { status: 200 }),
  });
  assert.deepEqual(result, { message_id: 7 });
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
