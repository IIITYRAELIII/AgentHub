(function workspaceReleaseWorkflowModule(global) {
  "use strict";

  const tooltip = [
    "Отдельные управляемые ветки задач; Test интегрирует проверенный результат в dev, Await — принятый результат в PreRelease.",
    "Карточки, история, чек-листы, результаты проверок и подтверждённые Git-операции сохраняются."
  ];

  const autoReviewTooltip = Object.freeze([
    "Исполнитель каждой задачи сам отправляет готовый результат на независимое ревью другому потоку Workspace.",
    "В запросе указывает требования, точную проверяемую версию, результаты тестов и свой поток для ответа. Ревьюер отвечает исполнителю напрямую.",
    "Поток ревьюера, ссылки на запрос, результат и заключение сохраняются в задаче. После исправлений повторное ревью идёт тому же потоку, в том числе после смены его чата.",
    "Основания возврата: невыполненные требования, реальные регрессии, нарушения применимого контракта или лишняя функциональность. Нужны конкретный сценарий и доказательства; посторонние старые ошибки и неподтверждённые замечания задачу не блокируют.",
    "Проверки соответствуют изменениям. Тесты и ревью одной зафиксированной версии можно выполнять параллельно. Неизменённый одобренный результат повторно не проверяется без новой причины.",
    "Тимлид не пересылает запросы и замечания между участниками. Его или пользователя подключают только для решения, которое исполнитель и ревьюер не могут принять сами.",
    "Положительное ревью не заменяет приёмку пользователем и обязательные проверки релиза. Пока нужен только ответ другого потока, текущий ход завершается.",
  ]);

  function renderParagraphs(container, paragraphs) {
    const document = container?.ownerDocument;
    if (!container || !document?.createElement) return false;
    container.replaceChildren(...paragraphs.map((text) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      return paragraph;
    }));
    return true;
  }

  function renderTooltip(container) { return renderParagraphs(container, tooltip); }
  function renderAutoReviewTooltip(container) { return renderParagraphs(container, autoReviewTooltip); }

  global.AgentHubWorkspaceTaskWorkflow = Object.freeze({
    tooltip: Object.freeze(tooltip.slice()),
    renderTooltip,
    autoReviewTooltip,
    renderAutoReviewTooltip,
  });
})(window);
