import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AsyncUserQuestionService, asyncQuestionFromItem } from "../../src/application/async-user-question-service.mjs";
import { AsyncUserQuestionStore } from "../../src/infrastructure/persistence/async-user-question-store.mjs";

const identity = { provider: "codex", streamId: "stream-a", threadId: "thread-a", turnId: "turn-a" };
const item = { type: "agentMessage", id: "call-question", phase: "final_answer", text: "",
  questions: [{ title: "Какой профиль?", options: ["Первый", "Второй"] }] };
const target = { provider: "codex", streamId: "stream-a", threadId: "thread-current" };

async function fixture(t, sender = async () => ({ accepted: true, pending: false })) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-question-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new AsyncUserQuestionStore({ dataDir });
  await store.load();
  const service = new AsyncUserQuestionService({ store, sendAnswer: sender, resolveTarget: async () => target });
  const question = await service.observe(item, identity);
  return { dataDir, store, service, question };
}

test("oversized combined reply stays editable before any intake claim", async (t) => {
  let sends = 0;
  const { store, service } = await fixture(t, async () => { sends += 1; });
  const question = await service.observe({ ...item, id: "long-question", questions:
    Array.from({ length: 5 }, () => ({ title: "q".repeat(20_000) })) }, identity);
  const answers = Object.fromEntries(question.questions.map((field) => [field.id, ["answer"]]));
  await assert.rejects(service.resolve(question.key, "submit", { answers }), /общий лимит/);
  assert.equal(store.get(question.key).state, "pending");
  assert.equal(sends, 0);
});

test("typed async question retains exact identity, options and free text", () => {
  const result = asyncQuestionFromItem(item, identity);
  assert.equal(result.questions[0].isOther, true);
  assert.deepEqual(result.questions[0].options.map((o) => o.label), ["Первый", "Второй"]);
  assert.notEqual(result.key, asyncQuestionFromItem(item, { ...identity, turnId: "another" }).key);
  assert.equal(asyncQuestionFromItem(item, { ...identity, streamId: null }), null);
  assert.equal(asyncQuestionFromItem({ ...item, questions: null }, identity), null);
});

test("question survives restart and duplicate provider completion without dispatch", async (t) => {
  let sends = 0;
  const { dataDir, store, service, question } = await fixture(t, async () => { sends += 1; return { accepted: true }; });
  await service.observe(item, identity);
  assert.equal(service.snapshot().length, 1);
  const recovered = new AsyncUserQuestionStore({ dataDir });
  await recovered.load();
  assert.equal(recovered.snapshot()[0].key, question.key);
  assert.equal(sends, 0);
  await assert.rejects(store.observe({ ...question, questions: [{ ...question.questions[0], question: "Подмена" }] }), /изменилось/);
});

test("two concurrent answer clicks share one dispatch, persisted before effect", async (t) => {
  let sends = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async (params) => {
    sends += 1;
    assert.equal(f.store.get(f.question.key).state, "dispatching");
    assert.equal(params.threadId, target.threadId);
    assert.equal(params.clientUserMessageId, f.question.clientUserMessageId);
    await blocked;
    return { accepted: true, pending: false };
  });
  const args = { answers: { 0: ["Мой вариант"] } };
  const a = f.service.resolve(f.question.key, "submit", args);
  const b = f.service.resolve(f.question.key, "submit", args);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([a, b]);
  assert.equal(sends, 1);
  assert.equal(f.store.get(f.question.key).state, "submitted");
  await f.service.resolve(f.question.key, "submit", args);
  await f.service.observe(item, identity);
  assert.equal(sends, 1);
  assert.deepEqual(f.service.snapshot(), []);
});

test("unknown delivery survives restart with immutable answer and destination", async (t) => {
  let first;
  const f = await fixture(t, async (params) => { first = params; throw new Error("connection lost"); });
  const args = { answers: { 0: ["Второй"] } };
  await assert.rejects(f.service.resolve(f.question.key, "submit", args), /connection lost/);
  assert.equal(f.service.snapshot()[0].state, "dispatching");
  await assert.rejects(f.service.resolve(f.question.key, "decline"), /Исход отправки неизвестен/);
  const recoveredStore = new AsyncUserQuestionStore({ dataDir: f.dataDir });
  await recoveredStore.load();
  let second;
  const recovered = new AsyncUserQuestionService({ store: recoveredStore,
    resolveTarget: async () => { throw new Error("Must use frozen target after rotation"); },
    sendAnswer: async (params) => { second = params; return { queued: true, pending: false }; } });
  await assert.rejects(recovered.resolve(f.question.key, "submit", { answers: { 0: ["Изменено"] } }), /тем же содержимым/);
  await recovered.resolve(f.question.key, "submit", args);
  assert.deepEqual(second, first);
});

test("missing or unconfirmed receipt never closes a question as submitted", async (t) => {
  const f = await fixture(t, async () => ({ accepted: true, pending: true }));
  await assert.rejects(f.service.resolve(f.question.key, "submit", { answers: { 0: ["Первый"] } }), /не подтверждён/);
  assert.equal(f.store.get(f.question.key).state, "dispatching");
});

test("dismissed question stays closed after provider replay and never dispatches", async (t) => {
  const f = await fixture(t, async () => { throw new Error("must not send"); });
  await assert.rejects(f.service.resolve(f.question.key, "submit", { answers: {} }), /Ответьте/);
  await f.service.resolve(f.question.key, "decline");
  await f.service.observe(item, identity);
  assert.deepEqual(f.service.snapshot(), []);
  await assert.rejects(f.service.resolve(f.question.key, "submit", { answers: { 0: ["Первый"] } }), /закрыт/);
});
