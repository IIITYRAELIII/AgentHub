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
| 17 | ✅ | Серверная Desktop policy вынесена в `src/interfaces/web/server-control-controller.mjs`: process/restart snapshot, автозапуск и накопление ожидающих рестарта безопасных настроек. |
| 18 | ✅ | Постоянные очереди изображений, голоса и TTS вынесены в `background-job-controller.mjs`: раздельные лимиты, дедупликация, восстановление и сохранение незавершённой работы при остановке. |
| 19 | ✅ | Shutdown composition вынесена в `runtime-lifecycle-controller.mjs`: однократный переход в stopping, остановка таймеров/управляемых ходов и независимое закрытие всех компонентов. |
| 20 | ✅ | Runtime-ресурсы регистрируются один раз в `runtime-resource-registry.mjs` и одинаково проходят фазы `flush`, `suspend`, `finalize` при restart и shutdown. |
| 21 | ✅ | Safe restart вынесен в `runtime-restart-controller.mjs`: ожидание offset/работ, запуск замены, восстановление предыдущего процесса и terminal finalize имеют один state machine. |
| 22 | ✅ | Кэш каталога вынесен в `task-catalog-service.mjs`: стабильная ссылка, revision, TTL, invalidate и coalescing параллельных rebuild. Provider discovery пока остаётся следующим этапом A4. |
| 23 | ✅ | Выбранная задача вынесена в `src/application/task-selection-store.mjs`: provider, project, thread ID и title изменяются атомарно одним владельцем, поддерживают revision и checkpoint rollback; внешняя мутация полей и карты thread ID запрещена. |
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
| 37 | ✅ | Composition root сокращён до 5 915 строк. `CodexContextMaintenanceService` владеет lifecycle очистки после свёртки, повторными попытками, безопасным recycle Codex App Server и периодической санацией rollout. Нестабильная очистка, запускаемая событием свёртки, остаётся явно отключённой; независимый периодический проход сохранён. |
| 38 | ✅ | Composition root сокращён до 5 732 строк. `CodexTerminalReconciliationService` владеет дедупликацией terminal-аудита, grace period, восстановлением пропущенных hook-событий, коррекцией provisional-записей и агрегацией исторических/субагентских ходов. |
| 39 | ✅ | Composition root сокращён до 5 657 строк. `ProviderTaskActivityService` владеет определением внешней активности Codex/Claude, а `SelectedTaskWatchService` — периодическим наблюдением выбранной внешней задачи, дедупликацией запуска и повторной проверкой selection/run после асинхронного snapshot. |
| 40 | ✅ | Composition root сокращён до 5 614 строк. `RateLimitTelemetryService` владеет безопасным Claude `/usage`, чтением Codex rate limits, форматированием текущего состояния и коалесцированным пятиминутным сохранением обеих серий в SQLite/work-log projection. |
| 41 | ✅ | Начат постепенный переход к слоистому `src`: application services активности провайдеров, наблюдения выбранной задачи и телеметрии лимитов перенесены вместе с импортами и тестами. Новый `TaskMetadataStore` владеет bounded-состоянием названий и настроек задачи, поддерживает будущий `hubTaskId` и сокращает composition root до 5 572 строк. Корневые entrypoint и совместимые CLI-пути не меняются. |
| 42 | ✅ | Runtime lifecycle получил физическую границу `src/runtime`: resource registry, shutdown lifecycle, safe restart и timer ownership перемещены одним срезом. Startup orchestration находится в `src/application`; все contract-тесты и production-импорты используют новые слои без compatibility shim и циклов. |
| 43 | ✅ | Общая provider-граница перенесена в `src/providers`: обязательный port registry, фабрики Codex/Claude, catalog builder и сервисы task/turn/catalog/completion/recovery. Composition root только связывает их зависимости; provider adapters не импортируют host и не закрепляют логическую задачу за одним thread/session ID. |
| 44 | ✅ | Desktop/VS Code/Mini App получили физическую interface-границу `src/interfaces/desktop`: RPC application/router policy, snapshot/history read-model, сообщения, вложения, настройки и deferred input. Корневой `desktop-control.mjs` остаётся стабильным IPC entrypoint для CLI и process-интеграций. |
| 45 | ✅ | Telegram command/message/callback dispatch, callback parser, polling policy, status и settings presentation перенесены в `src/interfaces/telegram`. Корневой Bot API transport сохранён как стабильная инфраструктурная граница; interface-слой не владеет task/run state. |
| 46 | ✅ | Зафиксированы точный inventory всех корневых production-модулей и их целевых слоёв, dependency matrix, верхняя граница composition root и runtime import-closure gate. Новые root-файлы, обратные зависимости слоёв и неполные релизы теперь отклоняются тестами до публикации. |
| 47 | ✅ | Provider preferences, task identity и durable runtime snapshot получили отдельных владельцев `AgentPreferencesStore`, `TaskIdentityResolver` и `HubRuntimeStateCoordinator`. `TaskSelectionStore` перенесён в `src/application`, `RuntimeStateStore` — в `src/infrastructure/persistence`; host больше не реализует restore/save snapshot и сокращён до 5 360 строк. |
| 48 | ✅ | Run lifecycle собран вокруг `RunCoordinator`: `ManagedRunLifecycleService` владеет регистрацией и завершением managed run, `DeferredInputStore/Service` — pending/queued state, `RunRecoveryCoordinator` — восстановлением, `RunConflictPolicy` — repository guard. Progress и observer state больше не имеют host-прокси; десять run-модулей перенесены в `src/application`, `src/domain` и `src/interfaces/telegram`, host сокращён до 5 138 строк. |
| 49 | ✅ | Полные реализации Codex/Claude перенесены в `src/providers/codex` и `src/providers/claude`, hook persistence — в `src/infrastructure/codex`. `CodexAppServerLifecycle`, `ClaudeTurnLauncher`, `CodexAccountingResolver` и provider snapshot helpers владеют процессом, запуском, accounting и преобразованием provider-событий; обратные зависимости interfaces/application устранены внедрением функций. Host сокращён до 4 928 строк. |
| 50 | ⏳ | Telegram presentation физически собран в `src/interfaces/telegram`; message bindings перенесены в persistence, terminal correlation — в application, расчёт отсутствующего Codex usage — в domain. Полный Web/Mini App/server-settings срез собран в `src/interfaces/web`. `DesktopTaskService` владеет task resolve/select/open и предпочитает будущий `hubTaskId`; host сокращён до 4 815 строк. Остальные Desktop handler bodies — следующий связный срез B4. |
| 51 | ⏳ | `DesktopSystemService` владеет status/read-model, историей лимитов и расхода, поиском с проекцией `hubTaskId` и trusted-device командами. Host сокращён до 4 762 строк; task mutations/restart/compaction ещё остаются B4/application-runtime срезом. |
| 52 | ⏳ | Общие create/rename/archive/cancel/diff handlers вынесены из Desktop composition в application `TaskCommandService`; сервис адресует логическую задачу через `hubTaskId`, а provider thread ID использует только как текущую внешнюю ссылку. Host сокращён до 4 707 строк; restart/compaction/speech остаются следующими владельцами. |
| 53 | ⏳ | Ручной запуск свёртки перенесён в `CodexContextMaintenanceService`: тот же provider-владелец проверяет активный ход, поднимает transport, возобновляет найденный rollout-thread и запускает compact с точным tracker ID. Host сокращён до 4 692 строк; restart/speech и оставшиеся тонкие Desktop adapters ещё относятся к B4. |
| 54 | ⏳ | `RestartRequestService` объединил одинаковую политику запросов перезапуска из Telegram и Desktop, а `DesktopSystemService` получил адресованную озвучку. В host больше нет Desktop handler bodies, кроме двух read-model composition adapters; размер — 4 647 строк. Оставшаяся Telegram presentation/composition — следующий срез B4. |
| 55 | ⏳ | `TelegramDeliveryService` владеет привязками входящих/исходящих сообщений, очисткой карточек задачи, durable outbox-доставкой, длинными ответами, заменой progress-карточек и уведомлениями выбора. Composition root больше не реализует Telegram delivery policy и сокращён до 4 346 строк. |
| 56 | ⏳ | `TaskNavigationService` владеет транзакционным переключением проекта, агента и выбранной задачи, включая rollback selection/preferences/diff. Открытие карточки меняет только локальную selection и не запускает provider; `hubTaskId` уже проходит через границу сервиса, а thread/session ID остаётся внешней ссылкой. Host сокращён до 4 279 строк. |
| 57 | ⏳ | `DeferredInputPresentationService` стал единственным владельцем переходов UI/receipt для saved/queued/dispatching/started сообщений. `TelegramTaskPickerService` владеет presentation списка задач, `InteractiveJobService` — bounded-очередью тяжёлых команд просмотра. Host сокращён до 4 193 строк. |
| 58 | ⏳ | `ManagedRunHistoryService` владеет слиянием активного/финального хода в локальную историю без дублей agent message. `RestartNotificationService` владеет announce/edit/fallback карточки безопасного перезапуска, а `TelegramCallbackController` — полной цепочкой typed callback handlers и stale fallback. Host сокращён до 4 085 строк. |
| 59 | ⏳ | `CodexTaskSnapshotService` теперь владеет не только чтением snapshot, но и повторным дочитыванием финального ответа, reindex наблюдаемого turn и применением model/reasoning/runtime projection. Форматирование approval/mode вынесено в Telegram presentation. Вторых владельцев этих обязанностей в host больше нет; размер — 4 045 строк. |

После этапов 31–40 provider adapters, Desktop/Mini App RPC, Telegram dispatch,
общая journal projection, observed lifecycle, progress presentation, startup и
timer/terminal-delivery/terminal-reconciliation/token-state/context-maintenance,
provider activity, selected-task watch, rate-limit telemetry и task metadata ownership больше не реализуются внутри
`agent-hub-server.mjs`. Файл всё
ещё велик, но оставшееся разделение должно идти по новым прикладным владельцам,
а не возвращать эти обязанности в composition root.

При следующих этапах нельзя делать provider thread ID постоянной идентичностью
задачи. Будущая durable-модель использует `hubTaskId`, которому соответствуют
несколько последовательных Codex thread ID или Claude session ID; подробный
переходный контракт зафиксирован в [ARCHITECTURE_V2.md](ARCHITECTURE_V2.md).
Правила распределения внутренних модулей по слоям описаны в
[`src/README.md`](src/README.md); перенос выполняется по одному проверяемому
срезу, а не массовым изменением путей.

Продолжение этапов 46+ ведётся крупными пакетами B0–B7 по единому плану
[`ARCHITECTURE_COMPLETION_PLAN.md`](ARCHITECTURE_COMPLETION_PLAN.md). Он задаёт
целевое дерево каталогов, dependency matrix, последовательность фактического
извлечения логики из host и критерий `agent-hub-server.mjs` ≤ 150 строк.

## Критерий завершения

Каждый этап закрывается только после полного `test:all`, повторных process E2E,
обновления live-runtime и успешного `doctor`. Публичные границы каждого
контроллера должны иметь отдельные unit-тесты.
