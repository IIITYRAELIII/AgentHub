# Декомпозиция agent-hub-server.mjs

Цель — оставить в `agent-hub-server.mjs` сборку зависимостей и состояние верхнего уровня, а исполняемый bootstrap держать в `agent-hub-main.mjs`. Протоколы, независимые сервисы и форматирование должны жить в тестируемых модулях. Перенос кода без явной границы ответственности не считается выполнением.

## Ограничения

- Не менять пользовательское поведение Telegram и формат сохранённого runtime-state.
- После каждого этапа выполнять syntax-check, все unit-тесты и все process E2E.
- Публиковать этап только после проверки рестарта и восстановления активных ходов.
- Не объединять декомпозицию с функциональными изменениями без отдельного теста на новый контракт.

## Этапы

| Этап | Статус | Граница |
|---:|:---:|---|
| 1 | ✅ | `TelegramClient`: JSON/multipart transport, обычные и длинные сообщения, status-card и typing lifecycle. |
| 2 | ✅ | Учёт токенов: нормализация, delta, суммирование и форматирование вынесены в `token-usage.mjs`. |
| 3 | ✅ | `CodexAppServerTransport`: процесс, JSON-RPC, таймауты, сигнал разрыва/reconnect, остановка дерева и ограниченный кэш `thread/read`. Политика восстановления ходов остаётся в композиции бота. |
| 4 | ✅ | `ClaudeRunController`: detached-процесс, файлы stdout/stderr, чтение и разбор `stream-json`, polling, завершение, отмена дерева и восстановление по PID/офсету. |
| 5 | ✅ | Task lifecycle: фабрики managed/observed run находятся в `task-runs.mjs`; `TaskProgressController` владеет progress UI, `TaskObserverController` — snapshot polling, `DeferredInputController` — очередью сообщений, а `task-recovery.mjs` — решениями восстановления после рестарта. |
| 6 | ✅ | Telegram controllers: `TelegramMessageController` маршрутизирует команды, reply и медиа; `TelegramCallbackController` и `telegram-callback-router.mjs` — callback-протокол; `ApprovalController` — подтверждения; `task-picker.mjs` и `TaskViewController` — выбор задач и историю. |
| 7 | ✅ | `MediaController`: загрузка изображений и аудио, Whisper, хранилище кнопок озвучивания, TTS worker и отправка voice. |
| 8 | ✅ | Базовая композиция: `TelegramPollingController` владеет Bot API polling; transports, controllers, storage и форматирование вынесены. |
| 9 | ✅ | Desktop snapshot: формирование снимков контекста, хода, задачи и общего состояния вынесено в `desktop-snapshot.mjs` с явными зависимостями и отдельными contract-тестами. |
| 10 | ✅ | Desktop history: чтение, объединение активного хода, пагинация и транспортный byte-budget вынесены в `desktop-task-history.mjs`. |
| 11 | ✅ | Desktop control router: ограничения Mini App, таблица команд и последовательная очередь мутаций вынесены в `desktop-control-router.mjs`. |
| 12 | ✅ | Desktop message controller: точная адресация задачи, идемпотентные квитанции, steer/queue, конфликт внешнего хода и запуск нового хода вынесены в `desktop-message-controller.mjs`. |
| 13 | ✅ | Ограниченный запуск внешних процессов вынесен в `process-capture.mjs`; модуль владеет тайм-аутом, остановкой процесса и byte-budget stdout/stderr. |
| 14 | ✅ | Runtime-уведомления вынесены в `runtime-notification-controller.mjs`: allowlist чатов, разрешённые cwd/файлы, очищенное окружение и запуск release-копий `send-message`/`send-images`. |
| 15 | ✅ | Codex lifecycle hooks вынесены в `codex-lifecycle-controller.mjs`: авторизация точного rollout, квитанции `turn-start`/`turn-complete`, baseline/diff, usage, журнал и финальная доставка. |
| 16 | ✅ | Telegram status/settings policy вынесена в `telegram-status-controller.mjs` и `telegram-settings-menu.mjs`; контроллер статуса владеет минутным кэшем лимитов и деградацией каталога. |
| 17 | ✅ | Серверная Desktop policy вынесена в `server-control-controller.mjs`: process/restart snapshot, автозапуск и накопление ожидающих рестарта безопасных настроек. |
| 18 | ✅ | Постоянные очереди изображений, голоса и TTS вынесены в `background-job-controller.mjs`: раздельные лимиты, дедупликация, восстановление и сохранение незавершённой работы при остановке. |
| 19 | ✅ | Shutdown composition вынесена в `runtime-lifecycle-controller.mjs`: однократный переход в stopping, остановка таймеров/управляемых ходов и независимое закрытие всех компонентов. |
| 20 | ✅ | Runtime-ресурсы регистрируются один раз в `runtime-resource-registry.mjs` и одинаково проходят фазы `flush`, `suspend`, `finalize` при restart и shutdown. |
| 21 | ✅ | Safe restart вынесен в `runtime-restart-controller.mjs`: ожидание offset/работ, запуск замены, восстановление предыдущего процесса и terminal finalize имеют один state machine. |
| 22 | ✅ | Кэш каталога вынесен в `task-catalog-service.mjs`: стабильная ссылка, revision, TTL, invalidate и coalescing параллельных rebuild. Provider discovery пока остаётся следующим этапом A4. |
| 23 | ✅ | Выбранная задача вынесена в `task-selection-store.mjs`: provider, project, thread ID и title изменяются атомарно одним владельцем, поддерживают revision и checkpoint rollback; внешняя мутация полей и карты thread ID запрещена. |
| 24 | ✅ | Provider discovery и merge каталога вынесены в `provider-task-catalog-builder.mjs`: источники опрашиваются параллельно, проецируются в стабильном порядке, сбой одного провайдера сохраняет durable-каталог и второй источник, managed runs объединяются до общей финализации. |
| 25 | ✅ | Основание общего command path вынесено в `application-command-bus.mjs`: task create/rename/archive из Telegram, Desktop и Mini App проходят один реестр, несут `clientId` и явную цель, а конфликтующие мутации сериализуются между клиентами. Bus уже предпочитает `hubTaskId`; перенос остальных команд остаётся этапом A5. |
| 26 | ✅ | Через тот же `ApplicationCommandBus` проходят выбор задачи, task-scoped/global settings, отмена хода и approvals во всех клиентах. Поздняя настройка несёт точную task-ссылку и не может примениться к задаче, выбранной после отправки команды; запуск/steer/deferred input остаются границей будущего `RunCoordinator`. |
| 27 | ✅ | Основание общего provider port вынесено в `agent-provider-registry.mjs`: адаптеры Codex/Claude обязательно реализуют discovery/projection, create, launch, cancel, external activity и live snapshot. Каталог, клиентские команды и observer обращаются к registry без выбора провайдера; completion/delivery/recovery завершаются в A6 отдельным срезом. |
| 28 | ✅ | Provider port завершён: те же обязательные адаптеры владеют recovery snapshot/подготовкой, managed и observed completion, terminal delivery, reattach, применением live snapshot и политикой restart/shutdown. Общий lifecycle делегирует по provider ID и не связывает логическую задачу с единственным thread ID. |
| 29 | ✅ | `RunCoordinator` объединяет admission, launch, steer, pending/queued input и provider terminal/recovery dispatch. Telegram, Desktop и Mini App используют одну task-lane; Desktop-контроллер оставляет у себя только подготовку вложений и идемпотентные клиентские квитанции. Lane предпочитает `hubTaskId` и поддерживает новый Claude-сеанс до появления session ID. |
| 30 | ✅ | Исполняемый bootstrap вынесен в `agent-hub-main.mjs`: process handlers, сигнал shutdown и запуск composition root имеют одну точку входа. `agent-hub-server.mjs` экспортирует idempotent `startAgentHub`/`shutdownAgentHub`, импорт больше не запускает сервер; runtime launchers, restart и process E2E используют новый main. |
| 31 | ✅ | Provider adapters и lifecycle выделены в отдельные сервисы discovery/catalog, create, launch/steer/cancel, events, live snapshot, completion и recovery. Публичные порты сохраняют task reference/`hubTaskId` и допускают последовательную смену thread/session ID. |
| 32 | ✅ | Desktop/Mini App используют отдельный application router, attachment/settings/deferred-input services, RPC read-model и точные task-scoped mutations поверх command bus/run coordinator. |
| 33 | ✅ | Telegram command dispatch и callback-группы settings/task/input выделены из composition root; transport/controller wiring осталось в host. |
| 34 | ✅ | Composition root сокращён с 8 158 до 6 252 строк. `RunProgressPresentation` владеет progress-представлением, `AgentHubStartupCoordinator` — порядком запуска, `TaskObservationService` — observed lifecycle, `RunJournalService` — последним сообщением и общей journal projection, `RuntimeTimerCoordinator` — именованными и keyed-таймерами. Наблюдаемый run сохраняет будущий `hubTaskId`. |
| 35 | ✅ | Composition root сокращён до 6 123 строк. `TurnEndDeliveryService` владеет точной terminal projection, дедупликацией, повторной доставкой и ожиданием usage, а `CodexRunFinalizer` — аудитом старта, фиксацией расхода/skills/MCP, историей, журналом и завершением управляемого Codex-хода. |
| 36 | ✅ | Composition root сокращён до 6 044 строк. `CodexUsageTracker` владеет bounded-картами накопительных token totals, per-turn usage и заполненности context window, а также совместимым восстановлением и сериализацией runtime-state. |

После этапов 31–36 provider adapters, Desktop/Mini App RPC, Telegram dispatch,
общая journal projection, observed lifecycle, progress presentation, startup и
timer/terminal-delivery/token-state ownership больше не реализуются внутри `agent-hub-server.mjs`. Файл всё
ещё велик, но оставшееся разделение должно идти по новым прикладным владельцам,
а не возвращать эти обязанности в composition root.

При следующих этапах нельзя делать provider thread ID постоянной идентичностью
задачи. Будущая durable-модель использует `hubTaskId`, которому соответствуют
несколько последовательных Codex thread ID или Claude session ID; подробный
переходный контракт зафиксирован в [ARCHITECTURE_V2.md](ARCHITECTURE_V2.md).

## Критерий завершения

Каждый этап закрывается только после полного `test:all`, повторных process E2E,
обновления live-runtime и успешного `doctor`. Публичные границы каждого
контроллера должны иметь отдельные unit-тесты.
