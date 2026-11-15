# Agent Hub — установка готового пакета

Установщик и поставки принадлежат публичному проекту
[AgentHub](https://github.com/IIITYRAELIII/AgentHub). Utilities для установки,
обновления и rollback не требуется. Исходный checkout, Git, npm и компилятор
получателю не нужны. Пока reviewed ready release не опубликован, установка
через Releases откажет; исходники вместо пакета не скачиваются.

## Запрос "обнови Utilities и Hub"

Для такого запроса используй существующий маршрут Utilities →
`UTILITY_INVENTORY.md` → публичное руководство AgentHub → versioned
`install_release.py` выбранного опубликованного релиза. Обновление Utilities
обрабатывает его обычный журнал и согласия участника. Hub устанавливается через
публичную поставку по этому руководству. Сверяй руководство и `--help` с выбранной
версией установщика.

Для существующего Hub сохрани прежний runtime root, приватный config/data,
компоненты, auth, sync URL, историю и original receipts. Команды fresh install,
stopped update, автоматического handoff, status и rollback используют один
установщик с соответствующей явной операцией. Их границы описаны ниже.

Поддерживается Windows x64. Нужны Python 3.10+ для `install_release.py` и Node.js
с модулем `node:sqlite` для Hub (проверяется установщиком; используй версию,
поддерживаемую проектом). Возьми versioned asset `install_release.py` и ready
package из одной версии Releases этого проекта. Перед запуском установщика
сверь его опубликованный SHA-256; сохрани контрольные суммы пакета.
Не используй исходный архив GitHub вместо готовой поставки.

```powershell
python install_release.py --release <exact-stable-tag> --runtime-root <private-runtime-directory> --scratch-root <separate-private-temporary-directory>
```

При первой установке добавь `--project-root <selected-project-directory>`.
Существующий configuration owner создаст непустой выбранный список проектов.
Приватная конфигурация уже установленного Hub сохраняется. Настрой нужные
компоненты и провайдера, затем запусти установленный Host и проверь Ready.
Один exit0 установщика подтверждает обработку пакета.

Источник установки и обновлений — только `IIITYRAELIII/AgentHub`.
`--release latest` выбирает stable release один раз, затем скачивает только его
versioned assets `AgentHub-win32-x64.zip` и `.zip.json`. Установщик сверяет SHA-256
и размеры обоих assets с анонимным GitHub API, согласованность descriptor/ZIP/source
identity, состав и хэши файлов. Отсутствие digest, неоднозначный asset,
draft/prerelease или ошибка сети дают отказ. Это целостность через доверенный
publisher/TLS, не отдельная подпись автора. Дополнительный `--sha256` фиксирует ZIP.

Для offline-установки используй `--archive <local-zip> --sha256 <published-sha256>`;
также поддерживается `--url <versioned-public-asset> --sha256 <published-sha256>`.
Runtime и scratch должны быть отдельными каталогами. Обычная установка без
`--prepare-update` требует заранее закрытых writers: живой или неизвестный runtime
даёт отказ. Этот stopped-only режим сам не останавливает и не запускает Hub.
Не обходи отказ повторной отправкой.

## Подготовка обновления работающего Hub

Для опубликованной целевой версии используй её проверенный versioned installer
того же пользователя. Codex внутри работающего Hub может выполнить эту команду.
Сохрани один exact stable tag, один original operation ID, тот же приватный
runtime root и отдельный приватный scratch вне runtime:

```powershell
python install_release.py --release <exact-stable-tag> --prepare-update --operation-id <original-update-id> --runtime-root <installed-private-runtime-root> --scratch-root <separate-private-scratch>
```

Для этого режима `latest` не допускается. Команда сохраняет и проверяет canonical
ZIP, descriptor, installer и manifest одной версии, затем передаёт исходную
операцию существующему package/restart owner. Utilities, Git, npm, пересборка
исходников и новая публикация получателю не нужны.

Для public **2.0.4 без package handoff** сначала закончи активную работу, но оставь
Hub запущенным до arm. Для этого legacy-пути нужен отдельный терминал вне Job
старого Hub. Подтверди показанный разовый ручной шаг. Только после
`awaiting-user-stop` с exact old Host/Node PIDs и release останови именно эту
старую группу в показанное 120-секундное окно. Не запускай новые ходы, второй Hub
и не меняй пользовательскую сессию. Updater не убивает процессы. Ручное
принудительное завершение не является graceful и может оставить работу UNKNOWN.

В поддерживающем handoff **Hub 2.1** та же команда использует реально объявленную
capability и аутентифицированный graceful restart: активная работа завершается,
существующий stopping fence закрывает writers. Потеря ответа этого пути не
переключает на ручной stop. Native continuation проверяет завершение всей exact
старой process/Job группы, делает согласованную копию config/data через SQLite
backup API, вызывает неизменённый stopped-only installer и один раз запускает
exact replacement. Успех требует exact ready и settlement исходной операции,
а не только exit0 установщика. WAL/SHM не копируются как live-файлы; backup не
восстанавливает данные и не повторяет UNKNOWN работу.

Если Codex выполняет обновление из самого Hub, после сохранённого ответа
`handoff.action = yield_current_turn` он завершает свой текущий ответ и ход.
Ожидание Ready внутри этого же хода удерживает работу, завершения которой ждёт
restart owner. Native Host продолжает исходную операцию после закрытия старой
Node/provider Job-группы. После перезапуска открой прежнюю беседу, прочитай статус
того же original и проверь Ready выбранного release. Потерянный ответ читается
через `--update-status` с прежним ID, без новой установки.

После прерывания или потери ответа читай только тот же original:

```powershell
python install_release.py --release <same-exact-stable-tag> --update-status --operation-id <same-original-update-id> --runtime-root <same-runtime-root> --scratch-root <same-private-scratch>
```

`--update-status` не запускает обновление. Отсутствующий original или незавершённое
скачивание не доказывают успех. Сохраняй scratch, receipts и backup; не удаляй их
для повтора, не меняй ID/tag и не запускай Hub вручную через unresolved admission.
При неоднозначном install/start нужен readback исходной операции, не второй запуск
или автоматический rollback. Поддерживаются Windows x64, стандартный runtime/data
layout и тот же интерактивный user/security context; чужие/живые/неизвестные
writers, другие layouts или elevation дают отказ. Нужен запас места под пакет,
config/data и backup; гарантии времени простоя нет. Controlled fixture checks не
являются доказательством фактического публичного обновления или provider AFTER.

## Rollback и сохранность данных

Для явного code-only rollback в закрытом stopped-writer окне добавь `--rollback`
к команде с доступным проверенным пакетом: существующий runtime owner выберет
сохранённую предыдущую версию.
Данные и конфигурация не откатываются. Существующие sync URL, выбор компонентов,
auth и cursors сохраняются; установщик не выбирает новый endpoint и не сбрасывает
пользовательские данные.

При управляемом переходе с Utilities укажи тот же установленный runtime root.
Удаление исходной папки из актуального дерева Utilities не является удалением
установленного Hub. Сохраняются настройки, данные, выбранные компоненты,
история Tasks, original receipts и прежние публикационные идентичности.
Старые записи согласий `.team` не удаляются и не превращаются в отказ от Hub;
они не создают второй updater. Изъятие исходников Utilities разрешено только
после проверки реального standalone package/download/update/rollback и границы
миграции существующим владельцем поставки. До этого работающая установка продолжает
использовать прежнюю идентичность. Этот CLI сам не меняет Git identity/release origin.

После первой установки отредактируй приватный `config.json` runtime и укажи
project root/нужные компоненты. Публичный пример не содержит частного sync endpoint;
при необходимости укажи свой в настройках Hub. Ключи храни в приватной конфигурации.
Затем запусти установленный `AgentHub.RuntimeHost.exe`.
Возможности, ограничения и провайдеры описаны в корневом README проекта.
