export function formatCommandApproval(params, run = null, activeProjectRoot = "") {
  const command = params.command ?? "(команда не указана)";
  const cwd = params.cwd ?? run?.projectRoot ?? activeProjectRoot;
  const reason = params.reason ? `\nПричина: ${params.reason}` : "";
  return `Codex запрашивает запуск команды:\n\n${command}\n\nКаталог: ${cwd}${reason}`;
}

export function formatFileApproval(params) {
  const reason = params.reason ? `\nПричина: ${params.reason}` : "";
  return `Codex запрашивает изменение файлов.${reason}\n\nИспользуйте /diff после выполнения для просмотра общего diff.`;
}

export function formatApprovalMode({ provider, autoApprove, autoApproveOnStart, claudePermissionMode }) {
  if (provider !== "codex") {
    return autoApprove
      ? "⚠️ Claude Code: bypassPermissions включён до перезапуска. Все действия выполняются без проверки разрешений."
      : `Claude Code: режим ${claudePermissionMode}. Для headless CLI отдельные запросы разрешений в Telegram недоступны.`;
  }
  return autoApprove
    ? `⚡ Автоподтверждение включено${autoApproveOnStart ? " по умолчанию" : " до перезапуска бота"}. Команды и изменения файлов выполняются без запроса.`
    : "🔐 Ручной режим. Команды и изменения файлов требуют подтверждения.";
}

export function approvalModeKeyboard({ autoApprove, callback }) {
  return {
    inline_keyboard: [[
      { text: autoApprove ? "⚡ Авто: включено" : "⚡ Включить авто", callback_data: callback("approval-mode:auto") },
      { text: autoApprove ? "🔐 Вернуть ручной" : "🔐 Ручной: включён", callback_data: callback("approval-mode:manual") },
    ]],
  };
}
