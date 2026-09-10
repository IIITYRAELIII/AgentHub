import path from "node:path";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { AsyncSqliteMutationQueue } from "./async-sqlite-mutation-queue.mjs";

// Questions own their lifecycle; command delivery remains in the canonical
// message ledger. Connections are short-lived so runtime replacement holds no
// extra open database handles. SQLite serializes overlapping runtime writers.
export class AsyncUserQuestionStore {
  #queue = new AsyncSqliteMutationQueue();
  constructor({ dataDir }) { this.file = path.join(dataDir, "async-user-questions.sqlite"); }
  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await this.#queue.run(() => {
      const db = new DatabaseSync(this.file);
      try {
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;");
        db.exec("CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL, answers TEXT, target TEXT, updated_at TEXT NOT NULL) WITHOUT ROWID");
      } finally { db.close(); }
    });
  }
  #read(operation) {
    const db = new DatabaseSync(this.file, { readOnly: true });
    try { return operation(db); } finally { db.close(); }
  }
  #row(row) { return row ? { ...JSON.parse(row.body), state: row.state,
    answers: row.answers ? JSON.parse(row.answers) : null,
    replyTarget: row.target ? JSON.parse(row.target) : null } : null; }
  get(key) { return this.#read((db) => this.#row(db.prepare("SELECT * FROM questions WHERE id=?").get(key))); }
  snapshot() {
    return this.#read((db) => db.prepare("SELECT * FROM questions WHERE state IN ('pending','dispatching') ORDER BY updated_at,id").all().map((row) => this.#row(row)));
  }
  #mutate(key, operation) {
    return this.#queue.run(() => {
      const db = new DatabaseSync(this.file);
      try {
        db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        const row = this.#row(db.prepare("SELECT * FROM questions WHERE id=?").get(key));
        const result = operation(db, row);
        db.exec("COMMIT");
        return result;
      } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error;
      } finally { db.close(); }
    }, { requestId: key });
  }
  observe(question) {
    return this.#mutate(question.key, (db, current) => {
      if (current) {
        if (JSON.stringify(current.questions) !== JSON.stringify(question.questions)
          || current.streamId !== question.streamId) throw new Error("Содержимое вопроса изменилось при той же идентичности");
        return current;
      }
      db.prepare("INSERT INTO questions (id,body,state,updated_at) VALUES (?,?,'pending',?)")
        .run(question.key, JSON.stringify(question), new Date().toISOString());
      return { ...question, state: "pending", answers: null };
    });
  }
  claim(key, answers, replyTarget) {
    return this.#mutate(key, (db, current) => {
      if (!current || current.state === "dismissed") throw new Error("Вопрос уже закрыт");
      if (current.answers && JSON.stringify(current.answers) !== JSON.stringify(answers)) {
        throw new Error("Ответ уже отправлялся. Повтор допускается только с тем же содержимым.");
      }
      const target = current.replyTarget ?? replyTarget;
      if (current.state !== "submitted") db.prepare("UPDATE questions SET state='dispatching',answers=?,target=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(answers), JSON.stringify(target), new Date().toISOString(), key);
      return { ...current, answers, replyTarget: target, state: current.state === "submitted" ? "submitted" : "dispatching" };
    });
  }
  markSubmitted(key) {
    return this.#mutate(key, (db, current) => {
      if (!current || !["dispatching", "submitted"].includes(current.state)) throw new Error("Ответ не был подготовлен");
      db.prepare("UPDATE questions SET state='submitted',updated_at=? WHERE id=?").run(new Date().toISOString(), key);
    });
  }
  dismiss(key) {
    return this.#mutate(key, (db, current) => {
      if (!current) throw new Error("Вопрос не найден");
      if (current.state === "dispatching") throw new Error("Исход отправки неизвестен; закрытие не отменяет доставку");
      if (current.state === "submitted") return { decision: "submitted" };
      db.prepare("UPDATE questions SET state='dismissed',updated_at=? WHERE id=?").run(new Date().toISOString(), key);
      return { decision: "declined" };
    });
  }
}
