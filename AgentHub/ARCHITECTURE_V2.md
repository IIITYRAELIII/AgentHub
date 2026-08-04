# Agent Hub architecture v2

## Зачем нужна перестройка

Agent Hub остаётся одним локальным процессом. Делить его на микросервисы не
нужно: это усложнит установку, обновление и восстановление. Требуется разделить
ответственность внутри процесса и заменить неявное глобальное состояние явными
контрактами.

Снимок на 2026-08-04:

- 141 production-модуль и около 38,5 тыс. строк JavaScript;
- `agent-hub-server.mjs` сокращён примерно с 8,5 до 6,5 тыс. строк; provider и
  client policy, progress presentation и startup orchestration уже вынесены,
  но общая journal/observer policy пока сохраняет top-level связность;
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
| A8 | ✅ | Исполняемый bootstrap выделен в `agent-hub-main.mjs`: он единственный устанавливает process-level error/signal handlers и запускает composition root. `agent-hub-server.mjs` экспортирует idempotent start/shutdown API и больше не стартует процесс при импорте. Launcher, restart и E2E используют новый entrypoint; `bot.mjs` оставлен compatibility shim. |
| A9 | ✅ | Provider adapters выделены из composition root: Codex и Claude имеют отдельные фабрики портов и сервисы catalog/task/turn/event/snapshot/completion/recovery. Интерфейсы принимают `hubTaskId`/task reference и не закрепляют один thread/session ID за логической задачей. |
| A10 | ✅ | Desktop и Mini App RPC разделены на application router, read-model и attachment/settings/deferred-input services; мутации проходят `ApplicationCommandBus` и `RunCoordinator` с явной задачей и `clientId`. |
| A11 | ✅ | Telegram command/callback dispatch выделен из composition root: transport/controller wiring осталось в host, команды и callback actions находятся в самостоятельных тестируемых сервисах. |
| A12 | 🔄 | `agent-hub-server.mjs` сокращён до 6 511 строк. Provider/client policy, progress presentation и startup orchestration вынесены; до чистого composition root остаётся выделить общую journal/observer policy и timer wiring. |

Каждый этап должен сохранять внешний протокол, получать отдельные contract-тесты
и проходить полный process E2E. Массовое переписывание за один релиз запрещено:
оно сделает невозможным локализовать регрессию в восстановлении задач.
