import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldLogPollingFailure,
  telegramPollingRetryDelay,
} from "./src/infrastructure/telegram/poll-retry.mjs";

test("Telegram polling retry uses a bounded exponential delay", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((failures) => telegramPollingRetryDelay(failures)),
    [3_000, 6_000, 12_000, 24_000, 30_000, 30_000],
  );
});

test("long polling outages log only the first and power-of-two failures", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 8, 9].filter(shouldLogPollingFailure),
    [1, 2, 4, 8],
  );
});
