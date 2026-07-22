# Tyrael Integration Desktop

Нативный Windows-клиент того же `Integration App Server`, которым пользуется Telegram-бот. Приложение не запускает второй Codex/Claude и не читает Telegram-токен.

В первой версии доступны:

- общий каталог Codex- и Claude-задач;
- текущая задача и все активные ходы;
- живые этапы, накопленный прогресс и формируемый ответ;
- переключение задачи без Telegram-уведомления;
- создание новой Codex- или Claude-задачи;
- отправка сообщения в свободную задачу через существующий Integration App Server.

Если задача либо тот же Git-репозиторий занят, приложение безопасно откажется запускать параллельный ход. Управление очередью, подтверждениями и отменой остаётся в Telegram до следующего этапа.

## Сборка и установка

На Windows достаточно встроенного .NET Framework, загрузка SDK и внешних пакетов не требуется:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\DesktopApp\install.ps1
```

Исполняемый файл устанавливается в `%LOCALAPPDATA%\Tyrael\TelegramIntegration\DesktopApp`, ярлык создаётся на рабочем столе. Сборка без установки:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\DesktopApp\build.ps1
```

Скомпилированный каталог `DesktopApp\dist` в Git не входит.
