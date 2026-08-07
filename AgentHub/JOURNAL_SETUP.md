# Личный журнал Agent Hub

Эта инструкция предназначена участнику команды и его Codex. Она устанавливает
личный журнал без Telegram, домена, Cloudflare и публичного доступа.

## Что устанавливается

- поддерживаемый базовый runtime Agent Hub без необязательных компонентов;
- пользовательские Codex hooks для точного начала и завершения хода;
- расширение `Agent HUB Work log` в профиль текущего пользователя VS Code;
- временно недоступная очистка дубликатов старых изображений из snapshot'ов
  штатного Codex-сжатия, оставленная в конфигурации только для совместимости;
- личная база `%LOCALAPPDATA%\AgentHub\data\journal.sqlite` с задачами,
  сообщениями, ходами, расходом, журнальной проекцией и историей лимитов.

Исходные rollout читаются из `%USERPROFILE%\.codex`. Журнал одного участника не
содержит данные другого и не отправляется в общий репозиторий.
Для SQLite не устанавливается отдельный сервер или npm-пакет: используется
`node:sqlite` из Node.js 22.5+ (рекомендуется Node.js 24+). История может быть
повторно восстановлена из Codex rollout и Claude transcript штатной командой
backfill. Старые `WORK_LOG.md`, `work-log-usage.json` и `task-sync.json`
используются только для проверяемой однократной миграции, архивируются и
удаляются после успешной сверки с SQLite.

Компонент `components.codexContextCleanup` временно выключен на всех установках,
пока механизм очистки переосмысливается. Обновление нормализует прежнее opt-in
в `false`, а Runtime не запускает ни очистку после свёртки, ни фоновый проход.
Сохранённые параметры `codexRolloutContext` пока не удаляются, чтобы не терять
совместимость и возможные пользовательские значения.

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
python Utilities/AgentHub/install.py
```

Включить очистку сейчас нельзя. Совместимый скрытый параметр
`--rollout-image-cleanup enabled|disabled` принимается только старыми
установочными сценариями и в обоих случаях нормализуется в «выключено».

На чистой установке команда автоматически восстанавливает старые локальные
ходы из `sessions` и `archived_sessions`. Исходные rollout не удаляются. До
применения создаётся резервная копия существующей журнальной базы и найденных
legacy-файлов.

После команды:

1. откройте в Codex `/hooks`, просмотрите и один раз доверьте
   `UserPromptSubmit` и `Stop`;
2. выполните в VS Code `Developer: Reload Window`;
3. нажмите значок `Agent HUB Work log` в Activity Bar;
4. проверьте `npm --prefix Utilities/AgentHub run hook:status`.

Если журнал истории нужно перестроить повторно:

```powershell
python Utilities/AgentHub/install.py --rebuild-history
```

## Подключение компонентов

Компоненты независимо включаются и выключаются повторным запуском установщика:

```powershell
python Utilities/AgentHub/install.py --enable-component telegram
python Utilities/AgentHub/install.py --enable-component mini-app
python Utilities/AgentHub/install.py --enable-component android-app
python Utilities/AgentHub/install.py --disable-component telegram
python Utilities/AgentHub/install.py --disable-component mini-app
python Utilities/AgentHub/install.py --disable-component android-app
```

`telegram` требует BotFather token и Telegram user ID. `mini-app` зависит от
Telegram, а `android-app` использует отдельную авторизацию доверенного
устройства. Оба мобильных компонента запускают общий внутренний Web App.
Требования к общему и собственному домену описаны в основном README.
Сохранённые Telegram-, Worker- и tunnel-настройки при отключении компонента не
стираются. Установщик сам запрашивает безопасный перезапуск существующего Hub.

## Что должен делать Codex

- читать `Utilities/AgentHub/README.md` перед изменением или диагностикой;
- не искать файл журнала в workspace: расширение читает личный SQLite runtime;
- проверять компоненты в `%LOCALAPPDATA%\AgentHub\config.json`;
- различать общие исходники в Git и личные данные внешнего runtime;
- при проблеме проверить `runtime:status`, `hook:status`, логи runtime и только
  затем объяснять причину;
- не просить Telegram token или домен, когда мобильные компоненты выключены.
