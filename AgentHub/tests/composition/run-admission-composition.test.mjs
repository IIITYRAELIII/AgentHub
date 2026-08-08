import assert from "node:assert/strict";
import test from "node:test";

import {
  contextCompactionRunIsInternal,
} from "../../src/composition/run-admission-composition.mjs";

test("standalone automatic compaction is internal but mid-turn compaction is not", () => {
  const compaction = { origin: "automatic", turnId: "compact-turn" };
  assert.equal(contextCompactionRunIsInternal({
    turnId: "compact-turn",
    promptPreview: "",
    responseText: "",
    userMessages: [],
  }, compaction), true);
  assert.equal(contextCompactionRunIsInternal({
    turnId: "compact-turn",
    promptPreview: "Продолжай",
    responseText: "",
    userMessages: [{ text: "Продолжай" }],
  }, compaction), false);
  assert.equal(contextCompactionRunIsInternal({
    turnId: "compact-turn",
    promptPreview: "",
    responseText: "Новый ответ",
    userMessages: [],
  }, compaction), false);
});

test("manual compaction is internal even if its observer inherited stale text", () => {
  assert.equal(contextCompactionRunIsInternal({
    turnId: "compact-turn",
    promptPreview: "Старый запрос",
    responseText: "Старый ответ",
  }, {
    origin: "manual",
    turnId: "compact-turn",
  }), true);
});

test("a restored context probe remains internal after process restart", () => {
  assert.equal(contextCompactionRunIsInternal({
    turnId: "probe-turn",
    promptPreview: "",
    responseText: "Ход завершён без текстового ответа.",
    userMessages: [],
  }, {
    origin: "automatic",
    turnId: "compaction-turn",
    probeTurnIds: ["probe-turn"],
  }), true);
});
