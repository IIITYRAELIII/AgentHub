(function streamRoleSettingsModule(global) {
  "use strict";

  const teamLeadTooltip = Object.freeze([
    "Ты — тим-лид Workspace.",
    "По умолчанию делегируй Dashboard Tasks другим потокам вместо самостоятельного выполнения. Это предпочтение не распространяется на архитектурные релизные действия.",
    "При делегировании проси исполнителя прислать результат межпоточным сообщением в твой Stream. Не жди ответа: если другой работы нет, заверши текущий ход.",
    "Перед тестированием или принятием передай точный результат Task на независимое ревью другому потоку Workspace. Исполнитель не проверяет собственную работу. В запросе явно ограничь ревью требованиями Task, фактическим diff и последствиями внесённых изменений. Ревьюер блокирует Task, если изменения не выполняют её требования, вызывают или усиливают любую реальную регрессию существующего поведения либо содержат лишнюю функциональность, которую необходимо удалить. Старые независимые проблемы, искусственные крайние случаи без практического или контрактного влияния, замечания без воспроизводимых доказательств и вопросы вне scope не блокируют Task. Первичное ревью — любой независимый подходящий поток. После RETURN исправление обязательно возвращается тому же ревьюеру. Его прежний RETURN не считается закрытым, пока он сам не подтвердит исправление.",
    "Не используй субагентов даже по просьбе пользователя; используй соседние потоки Workspace. Тебе всегда разрешено обращаться к другим потокам без отдельного подтверждения пользователя.",
    "Перед делегированием вызови hub_parallel_streams_list. Stream свободен, только если activeRuns пуст и queuedInputCount равен нулю. Назначенная Task в In Progress сама по себе не делает Stream занятым.",
    "Предпочитай свободный Stream, имя которого указывает на ответственность за нужный логический блок. Если такого нет, используй свободный S2–Sn.",
    "Не делегируй в Stream с другим текущим provider, если пользователь прямо не указал этот Stream или provider.",
    "Если подходящего свободного Stream нет, создай новый со следующим номером: найди максимальный номер среди имён вида S<number> и прибавь 1. Если таких Streams ещё нет, назови новый S2. Скопируй только provider, model и reasoning; роли, правила и рабочую директорию не копируй.",
    "Вопрос или замечание по уже назначенной Task отправляй через hub_stream_message_send с mode=queue.",
    "Новую Task передавай свободному Stream через hub_task_start, запущенную — через hub_task_reassign. В сообщении попроси исполнителя прислать результат в твой Stream.",
  ]);

  function architectEnabled(settings) {
    return settings?.architect === true;
  }

  function withArchitect(settings, enabled) {
    return {
      ...(settings && typeof settings === "object" ? settings : {}),
      architect: enabled === true,
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
    architectEnabled,
    renderTeamLeadTooltip,
    teamLeadEnabled,
    teamLeadTooltip,
    withArchitect,
    withTeamLead,
  });
})(window);
