(function streamRoleSettingsModule(global) {
  "use strict";

  const teamLeadTooltip = Object.freeze([
    "Ты — тим-лид Workspace.",
    "Распределяй задачи между подходящими потоками Workspace, сам их не выполняй. Выпуск релиза регулируется отдельной ролью Релиз-менеджера.",
    "Исполнитель и ревьюер общаются напрямую. Не пересылай их запросы и замечания; подключайся, только когда нужно решение или переназначение задачи.",
    "Если другой самостоятельной работы нет, заверши ход, не ожидая ответа потоков.",
  ]);

  function releaseManagerEnabled(settings) {
    return settings?.releaseManager === true;
  }

  function withReleaseManager(settings, enabled) {
    return {
      ...(settings && typeof settings === "object" ? settings : {}),
      releaseManager: enabled === true,
    };
  }

  function teamLeadEnabled(settings) {
    return settings?.teamLead === true;
  }

  function withTeamLead(settings, enabled) {
    return {
      ...(settings && typeof settings === "object" ? settings : {}),
      teamLead: enabled === true,
    };
  }

  function renderTeamLeadTooltip(container) {
    if (!container?.ownerDocument?.createElement) return false;
    container.replaceChildren(...teamLeadTooltip.map((text) => {
      const paragraph = container.ownerDocument.createElement("p");
      paragraph.textContent = text;
      return paragraph;
    }));
    return true;
  }

  global.AgentHubStreamRoleSettings = Object.freeze({
    releaseManagerEnabled,
    renderTeamLeadTooltip,
    teamLeadEnabled,
    teamLeadTooltip,
    withReleaseManager,
    withTeamLead,
  });
})(window);
