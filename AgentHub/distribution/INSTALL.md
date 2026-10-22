# Agent Hub — установка готового пакета

Установщик и поставки принадлежат публичному проекту
[AgentHub](https://github.com/IIITYRAELIII/AgentHub). Utilities для установки,
обновления и rollback не требуется. Исходный checkout, Git, npm и компилятор
получателю не нужны. Пока reviewed ready release не опубликован, установка
через Releases откажет; исходники вместо пакета не скачиваются.

Поддерживается Windows x64. Нужны Python 3.10+ для `install_release.py` и Node.js
с модулем `node:sqlite` для Hub (проверяется установщиком; используй версию,
поддерживаемую проектом). Возьми проверенный `install_release.py` из этого
проекта и ready package из его Releases, сохрани опубликованные SHA-256.
Не используй исходный архив GitHub вместо готовой поставки.

```powershell
python install_release.py --release <exact-stable-tag> --runtime-root <private-runtime-directory> --scratch-root <separate-private-temporary-directory>
```

Источник установки и обновлений — только `IIITYRAELIII/AgentHub`.
`--release latest` выбирает stable release один раз, затем скачивает только его
versioned assets `AgentHub-win32-x64.zip` и `.zip.json`. Установщик сверяет SHA-256
и размеры обоих assets с анонимным GitHub API, согласованность descriptor/ZIP/source
identity, состав и хэши файлов. Отсутствие digest, неоднозначный asset,
draft/prerelease или ошибка сети дают отказ. Это целостность через доверенный
publisher/TLS, не отдельная подпись автора. Дополнительный `--sha256` фиксирует ZIP.

Для offline-установки используй `--archive <local-zip> --sha256 <published-sha256>`;
также поддерживается `--url <versioned-public-asset> --sha256 <published-sha256>`.
Runtime и scratch должны быть отдельными каталогами. Перед обновлением штатно
останови writers; живой или неизвестный runtime заставит установщик отказать.
Не обходи отказ повторной отправкой. Автоматического stop/start/restart нет.

Для обновления используй тот же standalone-установщик с новым exact tag или
`latest`. Для rollback добавь `--rollback` к команде с доступным проверенным
пакетом: существующий runtime owner выберет сохранённую предыдущую версию.
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
миграции штатным владельцем поставки. До этого работающая установка продолжает
использовать прежнюю идентичность. Этот CLI сам не меняет Git identity/release origin.

После первой установки отредактируй приватный `config.json` runtime и укажи
project root/нужные компоненты. Публичный пример не содержит частного sync endpoint;
при необходимости укажи свой в настройках Hub. Ключи храни в приватной конфигурации.
Затем запусти установленный `AgentHub.RuntimeHost.exe`.
Возможности, ограничения и провайдеры описаны в корневом README проекта.
