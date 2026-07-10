# Telegram AI coding bridge

Однопользовательский Telegram-интерфейс к локальному Codex App Server или Claude Code CLI. Каждый владелец запускает отдельный экземпляр со своим Telegram-ботом, AI-аккаунтом и рабочей папкой.

## Требования

- Node.js 20 или новее;
- установленный и авторизованный Codex CLI либо Claude Code CLI;
- Python 3.10 или новее — только для распознавания и синтеза голосовых сообщений.

## Установка

Создайте бота через `@BotFather`, узнайте свой числовой Telegram user ID, затем выполните из этой папки:

```powershell
python install.py
npm run doctor
npm start
```

Установщик создаёт локальный `config.json`. Он содержит токен и исключён из Git. Для голосовых сообщений используйте:

```powershell
python install.py --install-voice
```

Для ручной настройки скопируйте `config.example.json` в `config.json`. Путь к другому конфигу можно передать через `TELEGRAM_CODEX_CONFIG`, а токен — через `TELEGRAM_BOT_TOKEN`.

### Codex models

`/model` switches the Codex model used for the next `turn/start` request. The selected value is saved in `data/state.json` and sent as the `model` field, so it remains sticky for later Codex turns in the same thread. Defaults are configured by `codexModel` and `codexModels` in `config.json`:

On Windows, the bot prefers the newest Codex binary bundled with the VS Code extension. Set `codexExecutable` or `CODEX_EXECUTABLE` only if you need to force a specific CLI path.

```json
{
  "codexExecutable": "",
  "codexModel": "gpt-5.5",
  "codexModels": [
    { "value": "gpt-5.5", "label": "GPT-5.5" },
    { "value": "gpt-5.6-sol", "label": "GPT-5.6-Sol" },
    { "value": "gpt-5.6-terra", "label": "GPT-5.6-Terra" },
    { "value": "gpt-5.6-luna", "label": "GPT-5.6-Luna" },
    { "value": "gpt-5.4", "label": "GPT-5.4" },
    { "value": "gpt-5.4-mini", "label": "GPT-5.4-Mini" },
    { "value": "gpt-5.3-codex-spark", "label": "GPT-5.3-Codex-Spark" }
  ]
}
```

For Claude Code, `/model` still switches `sonnet`, `opus`, or `haiku`.

### Claude Code (опционально)

Codex остаётся провайдером по умолчанию. Чтобы использовать Claude Code, сначала установите и авторизуйте CLI, затем укажите:

```json
{
  "provider": "claude",
  "claudeExecutable": "claude",
  "claudeModel": "sonnet",
  "claudePermissionMode": "acceptEdits"
}
```

Либо запустите установщик с `python install.py --provider claude`. Провайдер также переопределяется переменной `AI_PROVIDER`, путь к CLI — `CLAUDE_EXECUTABLE`, модель — `CLAUDE_MODEL`.

Claude запускается в headless-режиме и сохраняет `session_id`; продолжение доступно через `/resume <ID>`. CLI не предоставляет машиночитаемый список сессий, поэтому `/tasks` показывает только текущую сессию. `/status` получает актуальные лимиты через встроенную команду Claude Code `/usage`, не обращаясь к модели. Режим `acceptEdits` разрешает правки в рабочей папке, но не произвольные команды. Telegram-кнопка автоподтверждения включает `bypassPermissions` только до перезапуска и должна использоваться лишь в доверенной рабочей папке.

### Несколько рабочих папок

Добавьте разрешённые папки в `projects`. Значение `projectRoot` задаёт папку по умолчанию и должно совпадать с одним из путей:

```json
{
  "projectRoot": "C:\\Projects\\Main",
  "projects": [
    { "name": "Основной", "path": "C:\\Projects\\Main" },
    { "name": "Сайт", "path": "C:\\Projects\\Website" }
  ]
}
```

Если `projects` отсутствует, бот продолжает работать с единственным `projectRoot`. В Telegram используйте `/projects` или кнопку «📁 Проект». Кнопка показывается по умолчанию; чтобы скрыть её, установите `"showProjectButton": false` — команда `/projects` продолжит работать. При переключении создаётся новая задача в выбранной папке; список `/tasks` показывает только задачи активной папки. Во время выполнения задачи переключение заблокировано.

## Безопасность

- Доступ проверяется одновременно по `allowedUserIds` и `allowedChatIds`.
- По умолчанию принимаются сообщения только из приватных чатов.
- Codex работает с `workspaceWrite`, без сетевого доступа для команд агента.
- Claude Code использует собственную систему разрешений; рекомендуемый режим — `acceptEdits`.
- Подтверждения команд и изменений файлов отправляются владельцу в Telegram.
- Автоподтверждение выключено после каждого перезапуска.
- Не публикуйте `config.json`, каталоги `data`, `.venv-telegram`, `.whisper-models` и логи.

Бот предоставляет удалённый доступ к Codex и папкам из `projects` (либо к `projectRoot` в однопроектной конфигурации). Не добавляйте недоверенных пользователей в разрешённый список. Текущая версия не предназначена для совместного использования одного процесса несколькими людьми: состояние Codex и активная задача общие.

## Проверка и запуск

```powershell
npm run check
npm test
npm run doctor
npm start
```

В Windows также доступны `start.ps1` и `install-autostart.ps1`. PowerShell используется только для интеграции с автозапуском Windows; сам бот запускается Node.js.

Команды: `/projects`, `/new`, `/tasks`, `/resume`, `/current`, `/thread`, `/status`, `/approvals`, `/restart`, `/diff`, `/cancel`, `/help`.

`/thread` показывает ID текущего общего потока. Откройте активную папку в Codex App или VS Code и выберите этот поток в истории; из CLI его можно продолжить командой `codex resume <ID>`. Не отправляйте сообщения одновременно из нескольких интерфейсов, пока в потоке выполняется активная задача.

## Голосовые сообщения

Голос распознаётся локально через `faster-whisper`. Модель выбирается параметром `whisperModel`; файлы модели и временные аудиофайлы не попадают в Git.

Для длинных ответов и для любого ответа на голосовой запрос бот показывает кнопку `🔊 Озвучить`. Синтез выполняется локально через Silero TTS, а результат отправляется как Telegram voice message в OGG Opus. Worker загружается при первом нажатии и остаётся в памяти в течение `ttsIdleTimeoutSeconds` (по умолчанию 900 секунд), после чего автоматически завершается. Модель, голос, минимальная длина обычного ответа и максимальный объём озвучиваемого текста задаются параметрами `ttsModel`, `ttsSpeaker`, `ttsButtonMinChars` и `ttsMaxChars`. При первом озвучивании Silero скачивает модель в локальный кэш `.silero-models`.

## Изображения

Бот принимает Telegram-фотографии и файлы с MIME-типом `image/*`. Подпись к изображению используется как запрос; без подписи Codex анализирует картинку с учётом предыдущей переписки. Временный файл удаляется после завершения задачи.
