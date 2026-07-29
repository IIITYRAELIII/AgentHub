# Личный журнал Agent Hub

Эта инструкция предназначена участнику команды и его Codex. Она устанавливает
личный журнал без Telegram, домена, Cloudflare и публичного доступа.

## Что устанавливается

- поддерживаемый Agent Hub runtime в профиле `journal`;
- пользовательские Codex hooks для точного начала и завершения хода;
- расширение `Agent HUB Work log` в профиль текущего пользователя VS Code;
- личный `WORK_LOG.md` в корне выбранного workspace;
- необязательная очистка дубликатов старых изображений из snapshot'ов
  штатного Codex-сжатия без изменения его порога;
- личный ledger и таблица остатков лимитов под
  `%LOCALAPPDATA%\Tyrael\TelegramIntegration\data`.

Исходные rollout читаются из `%USERPROFILE%\.codex`. Журнал одного участника не
содержит данные другого и не отправляется в общий репозиторий.

Необязательная «очистка дубликатов изображений в rollout» оставляет исходные
сообщения и последние четыре изображения каждого snapshot'а. Она работает
только при явном `codexRolloutContext.enabled: true`, запускается до Codex App
Server и затем через заданный в `codexRolloutContext.scanIntervalSeconds`
интервал (по умолчанию 900 секунд, то есть 15 минут), но никогда не
переписывает rollout с активным ходом или открытый в VS Code, Codex Desktop
либо другом процессе. Такой файл автоматически обрабатывается после закрытия
треда или следующего запуска Agent Hub.

## Установка

Для автоматических заголовков журнала без отдельного обращения к модели сначала
установите актуальные правила workspace:

```powershell
python Utilities/AI_INFRA_SETUP/install_workspace_rules.py
```

Если существующий `AGENTS.md` отличается от командного шаблона, установщик
сообщит `merge required`. В этом случае Codex должен сохранить пользовательские
правила и добавить требование: первая строка каждого итогового ответа содержит
описательный заголовок не длиннее 70 символов, затем идёт пустая строка и
основной текст.

Откройте корень workspace в PowerShell и выполните:

```powershell
python Utilities/AgentHub/install.py --profile journal
```

Командный промпт установки отдельно спрашивает, включать ли очистку, и передаёт
установщику `--rollout-image-cleanup enabled` либо
`--rollout-image-cleanup disabled`. Явный выбор сохраняется только в локальном
`config.json`; отсутствие выбора безопасно означает «выключено».

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
