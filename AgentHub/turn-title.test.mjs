import assert from "node:assert/strict";
import test from "node:test";

import { conciseTurnTitle } from "./turn-title.mjs";

test("turn title skips generic acknowledgements", () => {
  assert.equal(
    conciseTurnTitle("Готово. Теперь доступны три переключаемых профиля Agent Hub."),
    "Теперь доступны три переключаемых профиля Agent Hub",
  );
  assert.equal(
    conciseTurnTitle("Исправлено.\n\nПрерванный ход восстановлен в журнале."),
    "Прерванный ход восстановлен в журнале",
  );
});

test("turn title removes Markdown furniture and ignores fenced code", () => {
  assert.equal(
    conciseTurnTitle([
      "```text",
      "служебная строка, которую нельзя брать",
      "```",
      "## Результат",
      "- Журнал получает полный финальный ответ из rollout.",
    ].join("\n")),
    "Журнал получает полный финальный ответ из rollout",
  );
});

test("turn title uses a bounded word-aware headline", () => {
  const title = conciseTurnTitle(
    "Реализовано автоматическое восстановление всех завершённых и остановленных ходов из локальных rollout-файлов без дополнительного обращения к модели.",
  );
  assert.ok(title.length <= 100);
  assert.match(title, /…$/u);
  assert.doesNotMatch(title, /\s…$/u);
});

test("turn title has a status-aware fallback", () => {
  assert.equal(conciseTurnTitle("", "completed"), "Ход завершён");
  assert.equal(conciseTurnTitle("Понял.", "aborted"), "Ход остановлен");
});
