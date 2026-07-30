# Декомпозиция agent-hub-server.mjs

Цель — оставить в `agent-hub-server.mjs` сборку зависимостей, состояние верхнего уровня и запуск приложения. Протоколы, независимые сервисы и форматирование должны жить в тестируемых модулях. Перенос кода без явной границы ответственности не считается выполнением.

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
| 7 | ✅ | `MediaController`: загрузка изображений и аудио, Whisper, хранилище кнопок озвучивания, TTS worker и отправка voice. Сохраняемые очереди фоновых заданий остаются общей политикой композиции. |
| 8 | ✅ | Базовая композиция: `TelegramPollingController` владеет Bot API polling; transports, controllers, storage и форматирование вынесены. |
| 9 | ✅ | Desktop snapshot: формирование снимков контекста, хода, задачи и общего состояния вынесено в `desktop-snapshot.mjs` с явными зависимостями и отдельными contract-тестами. |
| 10 | ✅ | Desktop history: чтение, объединение активного хода, пагинация и транспортный byte-budget вынесены в `desktop-task-history.mjs`. |
| 11 | ✅ | Desktop control router: ограничения Mini App, таблица команд и последовательная очередь мутаций вынесены в `desktop-control-router.mjs`. |
| 12 | ✅ | Desktop message controller: точная адресация задачи, идемпотентные квитанции, steer/queue, конфликт внешнего хода и запуск нового хода вынесены в `desktop-message-controller.mjs`. |

После этапа 12 `agent-hub-server.mjs` содержит около 7,4 тыс. строк. Это всё ещё
слишком много для удобного сопровождения: сервер остаётся точкой композиции и
хранит прикладную политику провайдеров, доставки, восстановления, Telegram UI и
фоновых задач. Следующие безопасные границы — lifecycle доставки Codex,
runtime-команды и Telegram menu/status policy; их следует переносить отдельными
этапами с contract-тестами, а не механически разрезать файл по размеру.

## Критерий завершения

Каждый этап закрывается только после полного `test:all`, повторных process E2E,
обновления live-runtime и успешного `doctor`. Публичные границы каждого
контроллера должны иметь отдельные unit-тесты.
