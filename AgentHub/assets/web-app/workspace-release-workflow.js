(function workspaceReleaseWorkflowModule(global) {
  "use strict";

  const tooltip = [
    "Любые изменения выполняются только в созданной и назначенной Dashboard Task.",
    "Диагностика и ответы без изменений не требуют Task; перед первой правкой Task обязательна.",
    "Task назначается текущему Stream и текущему ходу, а Git-корень берётся из настроек Stream или Workspace.",
    "Каждая Task получает отдельную ветку от main и управляемый sparse worktree.",
    "Переход в Test фиксирует результат Task и интегрирует его в dev.",
    "Переход в Await пересобирает PreRelease из main и всех принятых Await Tasks.",
    "Test-only изменения из dev не попадают в PreRelease.",
    "Конфликт не отменяет статус, но блокирует выпуск Task до успешной интеграции.",
    "Только явная команда «релиз» разрешает релизные проверки, push и production deployment.",
    "Публиковать зафиксированный состав релиза может только Architect.",
  ];

  global.AgentHubWorkspaceReleaseWorkflow = Object.freeze({
    tooltip: Object.freeze(tooltip.slice()),
  });
})(window);
