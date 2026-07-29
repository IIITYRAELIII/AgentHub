# Личный журнал Agent Hub

Эта инструкция предназначена участнику команды и его Codex. Она устанавливает
личный журнал без Telegram, домена, Cloudflare и публичного доступа.

## Что устанавливается

- поддерживаемый Agent Hub runtime в профиле `journal`;
- пользовательские Codex hooks для точного начала и завершения хода;
- расширение `Agent HUB Work log` в профиль текущего пользователя VS Code;
- личный `WORK_LOG.md` в корне выбранного workspace;
- личный ledger и таблица остатков лимитов под
  `%LOCALAPPDATA%\Tyrael\TelegramIntegration\data`.

Исходные rollout читаются из `%USERPROFILE%\.codex`. Журнал одного участника не
содержит данные другого и не отправляется в общий репозиторий.

## Установка

Откройте корень workspace в PowerShell и выполните:

```powershell
python Utilities/AgentHub/install.py --profile journal
```

На чистой установке команда автоматически восстанавливает старые локальные
ходы из `sessions` и `archived_sessions`. Исходники не удаляются. До применения
создаётся резервная копия существующих ledger и `WORK_LOG.md`.

После команды:

1. откройте в Codex `/hooks`, просмотрите и один раз доверьте
   `UserPromptSubmit` и `Stop`;
2. выполните в VS Code `Developer: Reload Window`;
3. нажмите значок `Agent HUB Work log` в Activity Bar;
4. проверьте `npm --prefix Utilities/AgentHub run hook:status`.

Если журнал истории нужно перестроить повторно:

```powershell
python Utilities/AgentHub/install.py --profile journal --rebuild-history
```

## Переключение профиля

Профиль меняется повторным запуском установщика:

```powershell
python Utilities/AgentHub/install.py --profile journal
python Utilities/AgentHub/install.py --profile telegram
python Utilities/AgentHub/install.py --profile full
```

`telegram` требует BotFather token и Telegram user ID, но не запускает Mini App.
`full` включает Telegram и разрешает настроенную Mini App. Сохранённые
Telegram-, Worker- и tunnel-настройки при переключении не стираются. После
смены профиля перезапустите существующий Agent Hub.

## Что должен делать Codex

- читать `Utilities/AgentHub/README.md` перед изменением или диагностикой;
- не редактировать `WORK_LOG.md`: его проецирует Agent Hub;
- проверять профиль в
  `%LOCALAPPDATA%\Tyrael\TelegramIntegration\config.json`;
- различать общие исходники в Git и личные данные внешнего runtime;
- при проблеме проверить `runtime:status`, `hook:status`, логи runtime и только
  затем объяснять причину;
- не просить Telegram token или домен для профиля `journal`.
