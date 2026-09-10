import { createHash } from "node:crypto";

export function asyncQuestionFromItem(item, { threadId, turnId, streamId, provider = "codex" } = {}) {
  if (item?.type !== "agentMessage" || !Array.isArray(item.questions) || !item.questions.length) return null;
  if (provider !== "codex" || !threadId || !turnId || !streamId || !item.id) return null;
  if (item.questions.length > 20) throw new Error("Слишком много вопросов в одном запросе");
  const questions = item.questions.map((question, index) => {
    const title = String(question?.title ?? "").trim();
    if (!title || title.length > 20_000) throw new Error("Некорректный текст вопроса");
    const options = question.options == null ? [] : question.options;
    if (!Array.isArray(options) || options.length > 30
      || options.some((option) => typeof option !== "string" || !option.trim() || option.length > 2_000)) {
      throw new Error("Некорректные варианты ответа");
    }
    return { id: String(index), header: `Вопрос ${index + 1}`, question: title,
      isOther: true, options: options.map((label) => ({ label, description: "" })) };
  });
  const identity = { provider, streamId, threadId, turnId, itemId: String(item.id) };
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return { ...identity, key: `question:${digest}`, kind: "async-user-input", questions,
    text: "Вопрос от агента. Можно ответить, пока он продолжает работу.",
    clientUserMessageId: `question-answer:${digest}` };
}

function normalizedAnswers(question, submitted) {
  const answers = {};
  for (const field of question.questions) {
    const raw = submitted?.[field.id];
    const values = (Array.isArray(raw) ? raw : [raw]).map((value) => String(value ?? "").trim()).filter(Boolean);
    if (values.length !== 1 || values[0].length > 20_000) throw new Error(`Ответьте на вопрос «${field.header}»`);
    answers[field.id] = values;
  }
  return answers;
}

function answerDisplayText(question, answers) {
  return question.questions.map((field) => `${field.question}\nОтвет: ${answers[field.id][0]}`).join("\n\n");
}

function answerMessage(question, answers) {
  const body = answerDisplayText(question, answers);
  return `Ответ на вопрос агента [${question.itemId}]\nИсходный Thread: ${question.threadId}\nИсходный ход: ${question.turnId}\n\n${body}`;
}

export class AsyncUserQuestionService {
  #inflight = new Map();
  constructor({ store, sendAnswer = null, resolveTarget = null }) {
    this.store = store;
    this.sendAnswer = sendAnswer;
    this.resolveTarget = resolveTarget;
  }
  setSender(sender, resolveTarget) { this.sendAnswer = sender; this.resolveTarget = resolveTarget; }
  async observe(item, identity) {
    const question = asyncQuestionFromItem(item, identity);
    if (question) await this.store.observe(question);
    return question;
  }
  snapshot() { return this.store.snapshot(); }
  async resolve(key, action, submitted = {}) {
    if (!["submit", "decline"].includes(action)) throw new Error("Неизвестное действие с вопросом");
    const current = this.store.get(key);
    if (!current) throw new Error("Вопрос не найден");
    if (action === "decline") return this.store.dismiss(key);
    if (!this.sendAnswer || !this.resolveTarget) throw new Error("Доставка ответа ещё не готова");
    const answers = normalizedAnswers(current, submitted.answers);
    // Fail before freezing a draft if ordinary message intake cannot accept it.
    const text = answerMessage(current, answers);
    if (text.length > 100_000) throw new Error("Ответ вместе с вопросами превышает общий лимит сообщения");
    // The durable claim freezes content before admission. An ambiguous send is
    // retried only by an explicit click, with the same canonical command ID.
    const replyTarget = current.replyTarget ?? await this.resolveTarget(current.streamId);
    if (!replyTarget?.provider || !replyTarget?.threadId || replyTarget.streamId !== current.streamId) {
      throw new Error("Не удалось определить поток для ответа");
    }
    const claim = await this.store.claim(key, answers, replyTarget);
    if (claim.state === "submitted") return { decision: "submitted", clientUserMessageId: claim.clientUserMessageId };
    if (this.#inflight.has(key)) return this.#inflight.get(key);
    const operation = (async () => {
      const receipt = await this.sendAnswer({ ...claim.replyTarget,
        clientUserMessageId: claim.clientUserMessageId, text,
        displayText: answerDisplayText(current, answers), followUpMode: "steer" });
      if (!receipt || receipt.failed === true || receipt.pending === true
        || (receipt.accepted !== true && receipt.queued !== true && receipt.deferred !== true)) {
        throw new Error("Приём ответа не подтверждён. Повторная отправка сохранит тот же идентификатор.");
      }
      await this.store.markSubmitted(key);
      return { decision: "submitted", clientUserMessageId: claim.clientUserMessageId };
    })();
    this.#inflight.set(key, operation);
    try { return await operation; } finally { this.#inflight.delete(key); }
  }
}
