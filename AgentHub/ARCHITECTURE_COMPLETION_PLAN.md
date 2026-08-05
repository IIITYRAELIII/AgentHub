# План завершения декомпозиции Agent Hub

## Исходное состояние

На 2026-08-05 уже выделены первые слои `src/application`, `src/providers`,
`src/interfaces` и `src/runtime`, но физическое перемещение модулей опередило
декомпозицию composition root:

- `agent-hub-server.mjs` — 5 572 строки, 136 импортов и 244 top-level функции;
- в корне Agent Hub остаётся 150 production-модулей `.mjs`;
- внутри `src` находится только 35 production-модулей;
- host всё ещё сам реализует восстановление состояния, Codex transport,
  доставку сообщений, значительную часть run lifecycle и обработчиков клиентов.

Следующие этапы считаются выполненными только при передаче ответственности
отдельному владельцу состояния или use case. Простое перемещение файлов больше
не является архитектурным этапом.

## Целевой результат

```text
AgentHub/
  agent-hub-main.mjs              # executable bootstrap
  agent-hub-server.mjs            # совместимый start/shutdown facade
  bin/                             # пользовательские CLI entrypoints
  scripts/                         # publish, install, migration, doctor
  src/
    composition/                   # создание и связывание компонентов
    domain/                        # Task, Run, identity, статусы и invariants
    application/                   # команды, use cases и владельцы state
    ports/                         # provider/client/storage/runtime contracts
    providers/
      codex/
      claude/
    interfaces/
      telegram/
      desktop/
      web/
    runtime/                       # process lifecycle и background jobs
    infrastructure/
      persistence/
      filesystem/
      process/
      network/
      telegram/
      cloudflare/
  test/
    unit/                          # структура повторяет src
    process/
  e2e/
  DesktopApp/
  AndroidApp/
```

`agent-hub-server.mjs` должен содержать только совместимый публичный API и вызов
composition factory. Целевой размер — не более 150 строк. Ни один composition
module не должен становиться новым монолитом: ориентир — не более 600 строк и
одна причина для изменения.

В корне остаются только стабильные публичные entrypoint/compatibility-фасады и
package-level файлы. Внутренний production-код и его тесты из корня уходят.

## Правила зависимостей

1. `domain` не зависит от application, provider, interface, runtime или
   infrastructure.
2. `application` зависит от `domain` и `ports`, но не от конкретных клиентов,
   файловой системы, SQLite или процессов.
3. `providers` и `interfaces` реализуют порты и не импортируют composition root.
4. `infrastructure` реализует storage/process/network ports и не владеет
   прикладными решениями.
5. `runtime` управляет жизненным циклом уже созданных компонентов, но не создаёт
   их самостоятельно.
6. Только `composition` знает конкретные реализации всех слоёв.
7. Все mutating-команды несут явные `hubTaskId`, `clientId` и message/request ID.
   Provider thread/session ID остаётся внешней ссылкой; один `hubTaskId` сможет
   последовательно владеть несколькими такими ссылками.
8. Циклы, импорт host из внутренних модулей и новые root production-модули
   запрещаются автоматической architecture-проверкой.

## Крупные пакеты работ

Пакеты выполняются целиком. После зелёных проверок работа без дополнительного
согласования продолжается со следующим пакетом, пока нет реальной блокировки или
конфликта с параллельными изменениями.

| Пакет | Статус | Содержание | Измеримый результат |
|---:|:---:|---|---|
| B0 | ✅ | Усилить architecture-тест: матрица разрешённых зависимостей, запрет новых внутренних файлов в корне, контроль размера host/composition и проверка import closure опубликованного runtime. Сформировать машинный inventory миграции. | Новые архитектурные нарушения не могут незаметно попасть в `main`. |
| B1 | ✅ | Выделить `HubRuntimeStateCoordinator`, `AgentPreferencesStore`, `TaskIdentityResolver` и восстановление runtime-state. Перенести state/config/persistence contracts в `application` и `infrastructure`. | В host больше нет загрузки/слияния/сериализации selection, provider settings и runtime snapshot. Фактический размер — 5 360 строк; оставшийся run/Telegram state закреплён за B2/B4, поэтому ориентир 4 700 не выдаётся за достигнутый. |
| B2 | ✅ | Запуск/steer, deferred input, progress, managed/observed lifecycle, recovery и repository conflict policy объединены вокруг `RunCoordinator`, `ManagedRunLifecycleService`, `DeferredInputService`, `RunRecoveryCoordinator` и `RunConflictPolicy`. Чистые host wrappers удалены, run/domain/Telegram progress-модули физически разнесены по `src`. | Один владелец каждого состояния хода для всех клиентов и провайдеров. Фактический host — 5 138 строк; provider-specific тела и interface handlers намеренно остаются пакетам B3/B4, поэтому ориентир 3 300 не выдаётся за достигнутый. |
| B3 | ✅ | Реализации Codex и Claude физически собраны в `src/providers/codex` и `src/providers/claude`; Codex App Server lifecycle, Claude launch/stream lifecycle, snapshot translation и accounting получили отдельных владельцев. Codex hook storage размещён в `src/infrastructure/codex`, а application/interface получают provider-функции через composition. | Из корня удалено 36 provider-модулей, host сокращён до 4 928 строк. Ориентир 2 200 не выдаётся за достигнутый: оставшиеся client handlers и общий wiring относятся к B4/B6. |
| B4 | ✅ | Telegram handlers/delivery/presentation, Desktop RPC/read-model и Mini App/Web lifecycle имеют владельцев в `src/interfaces`; клиенты вызывают общие application commands с явной задачей. | В host не осталось client handler bodies или форматирования сообщений. Фактический размер — 3 930 строк: остаток состоит главным образом из composition wiring, которое принадлежит B6; ориентир 1 200 не выдаётся за достигнутый. |
| B5 | ⏳ | Разнести инфраструктуру по `persistence/filesystem/process/network/telegram/cloudflare`; перенести SQLite, журналы, lock/process helpers, exchange rates, Bot API и Worker adapters. CLI и release scripts переместить в `bin/scripts` с совместимыми фасадами там, где путь уже публичен. | В корне остаётся только документированный allowlist внешних точек входа. |
| B6 | ⏳ | Корневой `agent-hub-server.mjs` уже стал 4-строчным start/shutdown facade. Wiring перенесён в `src/composition`; статические настройки, infrastructure, durable state/preferences, runtime lifecycle, Codex observability, provider wiring и базовые Telegram/Desktop/Web clients имеют отдельные factories до 234 строк. Оставшийся orchestrator — 3 350 строк — далее делится на application/interface controllers. | Host ≤ 150 строк уже достигнут; извлечённые composition factories защищены лимитом 600 строк. B6 завершится после разделения оставшегося orchestrator и автономной проверки startup/shutdown без запуска процесса. |
| B7 | ⏳ | Переместить unit/process tests в зеркальное дерево, удалить временные compatibility shims, обновить inventory/README/диаграмму и выполнить финальный аудит dead code и дублирующихся владельцев state. | Root production `.mjs` соответствует allowlist; полный runtime собирается только из нового дерева; старых внутренних путей нет. |

Ориентиры по строкам нужны для обнаружения «переноса без декомпозиции», но не
заменяют проверку ответственности. Пакет нельзя закрыть только потому, что файл
стал короче: новый владелец обязан иметь контрактные тесты и явные зависимости.

## Порядок работы внутри каждого пакета

1. Зафиксировать текущие функции и state, принадлежащие переносимой обязанности.
2. Сначала создать контракт владельца и regression-тесты существующего
   поведения.
3. Перенести всю обязанность одним связным изменением, а не по три функции.
4. Удалить старые wrappers/state из host и проверить отсутствие второго
   владельца поиском и architecture-тестом.
5. Переместить связанные production-модули и тесты в целевые папки.
6. Выполнить focused tests, затем `npm run test:all`, четыре process E2E,
   extension tests, runtime publish/import smoke и `doctor`.
7. Сделать отдельный тематический commit, push и безопасную публикацию. Если
   активные ходы задерживают restart, публикация не считается неуспешной, но
   ожидающий cutover явно фиксируется.

## Критерий полного завершения

- `agent-hub-server.mjs` не содержит прикладной логики и не превышает 150 строк;
- нет module-global mutable state вне одного документированного владельца;
- один и тот же use case вызывается Telegram, Desktop, Web/Android и VS Code
  через общий application command path;
- `hubTaskId` отделён от provider thread/session ID во всех новых публичных
  контрактах;
- dependency matrix, cycle check, root allowlist и staged-runtime import closure
  проверяются автоматически;
- все тесты, E2E, publish smoke, restart/recovery и `doctor` зелёные;
- документация описывает фактическое дерево и фактических владельцев, а не
  промежуточное состояние.
