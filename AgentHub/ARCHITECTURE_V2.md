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

## План миграции

| Этап | Статус | Результат |
|---:|:---:|---|
| A1 | ✅ | Единый `RuntimeResourceRegistry` для restart и shutdown. |
| A2 | ✅ | `RuntimeRestartController` с явным восстановлением старого процесса при неудачной замене. |
| A3 | ⬜ | `SelectionStore`: убрать прямые изменения provider/project/thread из обработчиков. |
| A4 | 🟡 | `TaskCatalogService` уже владеет кэшем, revision и coalescing; provider discovery/merge ещё переносится из composition root. |
| A5 | ⬜ | Общий command bus для Telegram/Desktop/Mini App вместо трёх таблиц прикладных обработчиков. |
| A6 | ⬜ | Общий `AgentProvider` port и адаптеры Codex/Claude. |
| A7 | ⬜ | `RunCoordinator`: единая state machine запуска, наблюдения, отмены, recovery и terminal delivery. |
| A8 | ⬜ | Выделить bootstrap в `agent-hub-main.mjs`; оставить composition root без бизнес-правил. |

Каждый этап должен сохранять внешний протокол, получать отдельные contract-тесты
и проходить полный process E2E. Массовое переписывание за один релиз запрещено:
оно сделает невозможным локализовать регрессию в восстановлении задач.
