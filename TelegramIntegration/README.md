# Telegram/Codex bridge

Локальный Telegram-интерфейс к Codex App Server для проекта `VSC_Tyrael`.

## Безопасность

- Бот принимает команды только от Telegram user ID `859219009`.
- Токен читается из `Utilities/TelegramIntegration/TGBotToken.txt` и не выводится в журнал.
- Codex работает в режиме `workspaceWrite` только в каталоге проекта.
- Сеть для команд агента отключена.
- Команды и изменения файлов, требующие разрешения, подтверждаются кнопками Telegram.
- Токен и локальное состояние исключены из Git корневым `.gitignore`.

## Запуск

Из корня проекта:

```powershell
.\Utilities\TelegramIntegration\start.ps1
```

Процесс должен оставаться запущенным. После запуска отправьте боту `/start`.

## Автозапуск

Чтобы запускать бота и открывать проект в VS Code при входе в Windows:

```powershell
.\Utilities\TelegramIntegration\install-autostart.ps1
```

Команды: `/new`, `/tasks`, `/resume`, `/current`, `/status`, `/diff`, `/cancel`, `/help`.

Это отдельный клиент Codex, работающий с той же папкой и Git-репозиторием, что и VS Code. Он не управляет интерфейсом расширения VS Code и не продолжает его текущий чат.

## Голосовые сообщения

Голосовые и аудиосообщения распознаются локально через `faster-whisper` с моделью `small`, после чего текст передаётся Codex как обычная команда. Окружение `Utilities\TelegramIntegration\.venv-telegram`, модель `Utilities\TelegramIntegration\.whisper-models` и временные аудиофайлы не попадают в Git.
