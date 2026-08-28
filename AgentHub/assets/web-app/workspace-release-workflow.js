(function workspaceReleaseWorkflowModule(global) {
  "use strict";

  const tooltip = [
    "До содержательной работы нужно найти существующую Dashboard Task или создать новую.",
    "Текущий Stream сразу назначается исполнителем Task в своём Workspace.",
    "В конце каждого хода Task получает актуальные work log, изменённые файлы и статус.",
    "Ход без diff не создаёт запись файла или evidence.",
    "Завершённое исправление автоматически переходит в «К применению» только после точного terminal evidence.",
    "Завершённый анализ закрывается после результата или смены темы пользователем; незавершённый остаётся открытым.",
    "Любой Архитектор Workspace выбирает ожидающие Tasks и проверяет видимый результат.",
    "После проверенного релиза только вошедшие в него Tasks переходят в «Готово» и закрываются.",
  ];

  global.AgentHubWorkspaceReleaseWorkflow = Object.freeze({
    tooltip: Object.freeze(tooltip.slice()),
  });
})(window);
