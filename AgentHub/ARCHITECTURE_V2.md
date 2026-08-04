# Agent Hub architecture v2

## Зачем нужна перестройка

Agent Hub остаётся одним локальным процессом. Делить его на микросервисы не
нужно: это усложнит установку, обновление и восстановление. Требуется разделить
ответственность внутри процесса и заменить неявное глобальное состояние явными
контрактами.

Снимок на 2026-08-04:

- 141 production-модуль и около 38,5 тыс. строк JavaScript;
- `agent-hub-server.mjs` — около 8,3 тыс. строк, 96 импортов, 46 изменяемых
  top-level переменных и примерно 270 функций;
- циклических импортов нет;
- основные дефекты возникают из-за скрытых зависимостей через module globals,
  нескольких конкурирующих представлений одной задачи и разного lifecycle для
  Telegram, Desktop, Mini App, Codex и Claude.

## Целевая схема

```text
Clients (Telegram / Desktop / VS Code / Web / Android)
                         │
                         ▼
              Application command bus
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     Task service    Run service    Inbox service
          │              │              │
          └──────────────┼──────────────┘
                         ▼
                 Domain event stream
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     SQLite views   Client updates   Notifications

Provider ports: CodexProvider / ClaudeProvider
Infrastructure ports: Telegram / filesystem / process / SQLite / Worker
Host: composition, startup, restart and shutdown only
```

### Правила

1. `agent-hub-server.mjs` — composition root, а не место прикладной логики.
2. Клиенты отправляют одинаковые команды с явным `taskId`, `messageId` и
   `clientId`; глобально выбранная задача не используется для мутаций.
3. `Task`, `Run`, `Selection` и `DeferredInput` имеют по одному владельцу
   состояния. SQLite — canonical durable read model; provider rollout/transcript
   — внешний источник событий, а не параллельный каталог.
4. Codex и Claude реализуют общий provider port. Различия CLI/App Server
   остаются внутри адаптеров.
5. Все принятые мутации получают durable receipt до внешнего эффекта.
6. UI получает snapshot и последовательность событий с revision; поздний ответ
   со старой revision отбрасывается одинаково во всех клиентах.
7. Runtime-ресурсы регистрируются один раз и проходят явные фазы:
   `flush → suspend → finalize`.

### Будущая идентичность задачи

Следующая версия модели данных вводит стабильный `hubTaskId` как первичный ключ
логической задачи Agent Hub. Один `hubTaskId` может владеть несколькими
последовательными Codex thread ID или Claude session ID. Завершённый provider
thread консервируется, создаёт handoff и передаёт продолжение новому thread, но
название, пользовательская история и идентичность задачи сохраняются.

До отдельной миграции текущий provider thread ID остаётся compatibility key.
Новые сервисы и публичные команды не должны закреплять предположение
`taskId === threadId`: command bus адресует `hubTaskId`, provider ID является
внешней ссылкой, а durable-модель должна разделять сущности `tasks` и
`task_threads`. `TaskSelectionStore` считается переходной границей: при миграции
меняется его внутреннее разрешение `hubTaskId → active provider thread`, а не
обработчики всех клиентов.

## План миграции

| Этап | Статус | Результат |
|---:|:---:|---|
| A1 | ✅ | Единый `RuntimeResourceRegistry` для restart и shutdown. |
| A2 | ✅ | `RuntimeRestartController` с явным восстановлением старого процесса при неудачной замене. |
| A3 | ✅ | `TaskSelectionStore` — единственный владелец provider/project/thread/title; обработчики используют атомарные команды и checkpoint rollback, изменения имеют revision. |
| A4 | ✅ | `ProviderTaskCatalogBuilder` владеет параллельным discovery, durable fallback, изоляцией ошибок источников и merge с managed runs; `TaskCatalogService` владеет кэшем, revision и coalescing. Provider-specific transport остаётся до A6. |
| A5 | ✅ | `ApplicationCommandBus` объединяет selection, task create/rename/archive, settings, run cancel и approvals для Telegram/Desktop/Mini App; команды требуют `clientId`, task-мутации — явную цель, конфликтующие операции сериализуются между клиентами. Адресация предпочитает будущий `hubTaskId`, а provider thread ID остаётся compatibility ref. Запуск/steer/deferred input переходят вместе с `RunCoordinator` на A7. |
| A6 | ✅ | `AgentProviderRegistry` задаёт обязательный port Codex/Claude для discovery/projection, create, launch, cancel, external activity, live/recovery snapshot, observed/managed completion, recovery и restart/shutdown policy. Общий task-run lifecycle больше не выбирает провайдера условными ветками. |
| A7 | ✅ | `RunCoordinator` владеет admission state machine запуска, steer/deferred input и task-lane между Telegram/Desktop/Mini App; managed/observed completion и recovery входят через него в единый provider port. Lane предпочитает будущий `hubTaskId`, но разрешает новый provider-сеанс без ThreadID до первого события CLI. |
| A8 | ⬜ | Выделить bootstrap в `agent-hub-main.mjs`; оставить composition root без бизнес-правил. |

Каждый этап должен сохранять внешний протокол, получать отдельные contract-тесты
и проходить полный process E2E. Массовое переписывание за один релиз запрещено:
оно сделает невозможным локализовать регрессию в восстановлении задач.
