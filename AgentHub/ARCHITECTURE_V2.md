# Agent Hub architecture v2

## Зачем нужна перестройка

Agent Hub остаётся одним локальным процессом. Делить его на микросервисы не
нужно: это усложнит установку, обновление и восстановление. Требуется разделить
ответственность внутри процесса и заменить неявное глобальное состояние явными
контрактами.

Снимок на 2026-08-04:

- 144 production-модуля и около 39 тыс. строк JavaScript;
- `agent-hub-server.mjs` сокращён примерно с 8,5 до 6,25 тыс. строк; provider и
  client policy, progress presentation, startup orchestration, journal
  projection, observed lifecycle и timer ownership имеют отдельных владельцев;
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
| A12 | ✅ | `agent-hub-server.mjs` сокращён до 6 252 строк. `TaskObservationService` владеет созданием, обновлением и terminal-policy наблюдаемых ходов; `RunJournalService` — bounded last-message state, общей projection и SQLite cutover; `RuntimeTimerCoordinator` — именованными дедлайнами и keyed cleanup-таймерами. `hubTaskId` сохраняется при подключении к внешнему ходу. |
| A13 | ✅ | `agent-hub-server.mjs` сокращён до 6 123 строк. `TurnEndDeliveryService` стал единственным владельцем terminal projection/retry/usage wait, а `CodexRunFinalizer` — финального учёта управляемого Codex-хода, включая diff, usage, фактически использованные skills/MCP, историю и durable delivery. Границы принимают `hubTaskId`, не превращая provider thread ID в постоянный ключ задачи. |
| A14 | ✅ | `agent-hub-server.mjs` сокращён до 6 044 строк. `CodexUsageTracker` инкапсулирует bounded token/context state, вычисление дельт, очистку завершённого хода и совместимый runtime snapshot; provider services получают прежнюю map-границу только как переходный порт. |
| A15 | ✅ | `agent-hub-server.mjs` сокращён до 5 915 строк. `CodexContextMaintenanceService` стал единственным владельцем реакции на завершение свёртки, retry-window, безопасного recycle транспорта и периодической санации rollout. Все операции адресуются provider thread ID текущего сеанса и не используют его как постоянную идентичность логической задачи; это сохраняет переход к `hubTaskId → несколько threadId/sessionId`. |
| A16 | ✅ | `agent-hub-server.mjs` сокращён до 5 732 строк. `CodexTerminalReconciliationService` стал единым владельцем дедупликации terminal-аудита, grace period, восстановления пропущенной финализации, коррекции provisional-журнала и агрегации субагентов. Вход принимает точную пару provider thread/turn текущего сеанса, а проекция отдельно получает task thread родителя, не смешивая их с будущим `hubTaskId`. |
| A17 | ✅ | `agent-hub-server.mjs` сокращён до 5 657 строк. `ProviderTaskActivityService` определяет фактическую активность provider-сеанса, а `SelectedTaskWatchService` владеет автоматическим подключением к выбранной внешней задаче. После каждого асинхронного snapshot сервис повторно проверяет точную selection и наличие managed run, поэтому поздний результат не применяется к другой логической задаче; task key уже предпочитает `hubTaskId`. |
| A18 | ✅ | `agent-hub-server.mjs` сокращён до 5 614 строк. `RateLimitTelemetryService` стал единым владельцем безопасного Claude `/usage`, Codex rate-limit RPC, форматирования текущих лимитов и коалесцированного фонового сохранения. Пятиминутный цикл изолирует ошибки провайдеров и не допускает двух одновременных poll одного runtime. |
| A19 | ✅ | Введён слоистый внутренний каталог `src`; первые application services перенесены без изменения стабильных точек входа. `TaskMetadataStore` стал единым bounded-владельцем закреплённых названий, ожидаемых подтверждений переименования и настроек Codex. Его ключ уже предпочитает `hubTaskId`, сохраняя совместимость с текущими provider thread/session ID. `agent-hub-server.mjs` сокращён до 5 572 строк. |
| A20 | ✅ | Слой `src/runtime` получил единый registry ресурсов, контроллеры lifecycle/restart и координатор таймеров; startup coordinator размещён в `src/application`. Импорты и contract-тесты перенесены вместе с владельцами, runtime packager сохраняет вложенную структуру, а стабильные entrypoint/CLI остаются в корне. |
| A21 | ✅ | Общий provider port физически выделен в `src/providers`: registry, фабрики адаптеров, catalog merge и сервисы task/turn/completion/recovery перенесены одним связным срезом. Application composition зависит от общего контракта, а provider thread/session ID остаются внешними ссылками, не идентичностью будущего `hubTaskId`. |
| A22 | ✅ | Внутренний Desktop/VS Code/Mini App interface выделен в `src/interfaces/desktop`: application router, transport policy router, snapshot/history read-model, message, attachment, settings и deferred-input controllers. Стабильный IPC-модуль `desktop-control.mjs` оставлен в корне для CLI, publish/restart и внешней совместимости. |
| A23 | ✅ | Внутренний Telegram interface выделен в `src/interfaces/telegram`: command/message/callback routing, polling policy, status и settings presentation. Низкоуровневый Bot API transport и compatibility CLI остаются на стабильных корневых путях; interface-модули зависят только от инъецированных application operations и общих парсеров. |
| A24 | ✅ | Введён исполняемый migration inventory для 149 корневых production-модулей, dependency matrix слоёв и запрет роста composition root. Runtime deployment до cutover проверяет closure статических, side-effect, re-export и literal dynamic imports, поэтому неполный релиз не может стать активным. |
| A25 | ✅ | `AgentPreferencesStore` владеет моделями, reasoning/mode, учётом Claude и task-specific Codex settings; `TaskIdentityResolver` — текущей task reference, UI context и title metadata; `HubRuntimeStateCoordinator` — полным циклом load/canonicalize/restore/snapshot/serialized save. Selection и SQLite state store физически перенесены в `src`; composition root сокращён до 5 360 строк. |
| A26 | ✅ | `RunCoordinator` стал общей точкой admission/steer/queue/provider dispatch, а lifecycle, deferred state, recovery и repository conflict получили отдельных application-владельцев. Deferred item сохраняет `hubTaskId` отдельно от текущего provider thread/session ID; progress/observer/domain-модули перенесены в целевые слои, host сокращён до 5 138 строк. |
| A27 | ✅ | Provider implementation boundary завершена физически: Codex и Claude находятся в отдельных каталогах, Codex App Server lifecycle, Claude launch/stream, snapshot translation и subagent accounting имеют собственные сервисы. Interfaces/application не импортируют provider implementation напрямую; конкретные функции связывает composition root. Host сокращён до 4 928 строк. |

Каждый этап должен сохранять внешний протокол, получать отдельные contract-тесты
и проходить полный process E2E. Массовое переписывание за один релиз запрещено:
оно сделает невозможным локализовать регрессию в восстановлении задач.

Правила постепенного размещения модулей по слоям зафиксированы в
[`src/README.md`](src/README.md). Корневые entrypoint, CLI и release-модули
остаются на прежних путях; внутренние сервисы переносятся законченными срезами.

Полный маршрут от текущих 5 572 строк composition root до тонкого facade,
целевое дерево каталогов, dependency rules и семь крупных пакетов B0–B7
зафиксированы в
[`ARCHITECTURE_COMPLETION_PLAN.md`](ARCHITECTURE_COMPLETION_PLAN.md). Этот план
заменяет дальнейшее дробление на микропереносы: пакет закрывается только после
передачи целой ответственности, удаления старого владельца и полного validation
gate.
