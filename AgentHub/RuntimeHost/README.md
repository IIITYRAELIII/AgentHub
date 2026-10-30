# Agent Hub Runtime Host

`AgentHub.RuntimeHost.exe` — минимальная Windows-точка запуска Agent Hub без
`VBS`, `wscript.exe`, скрытого PowerShell и `ExecutionPolicy Bypass`.

Runtime Host собирается системным компилятором .NET Framework во временный
runtime-release командой `node runtime-manager.mjs deploy`. Скомпилированный
EXE не хранится в Git. Пока исходники Runtime Host не изменились, следующие
release переиспользуют точную установленную копию с тем же SHA-256. После
публикации EXE атомарно копируется в
`%LOCALAPPDATA%\AgentHub\AgentHub.RuntimeHost.exe`.

При отсутствии установленного EXE кэш SHA-256 не заменяет сам файл:
`deploy` заново собирает launcher, даже если файлы хешей сохранились. Сам `deploy`
не создаёт ярлык автозагрузки и не запускает остановленный Hub. Для полного
восстановления после карантина используйте штатный установщик по инструкции
[JOURNAL_SETUP.md](../JOURNAL_SETUP.md#восстановление-после-карантина-defender).
Пересборка неизменённых исходников не является исправлением детекта Defender;
отсутствие угроз в локальной проверке не заменяет заключение Microsoft.

Перед запуском Node.js Runtime Host проверяет `current.json`, отсутствие
reparse-point в управляющих каталогах, размер и SHA-256 каждого файла из
`runtime-manifest.json`. Автозагрузочный ярлык указывает непосредственно на EXE.

Служебные режимы:

- `--check` — проверить активный release и наличие Node.js без запуска Hub;
- `--install-autostart` — создать пользовательский ярлык автозагрузки;
- `--spawn-independent` — холодный запуск через удерживаемый native handle
  текущего Windows shell как явного родителя. До Resume проверяются реальный
  parent, отсутствие любых Job у child и тот же эффективный security context.
  Недоступный shell, иной token или Job дают отказ без fallback. Флаг нельзя
  использовать с идентификатором управляемого рестарта.
- `--package-handoff` — внутренний exact-package режим существующего рестарта;
  `--package-bootstrap` — его package-side вход для старого public runtime.
  Оба требуют исходную durable operation и проверенные package/cohort bindings,
  удерживают исходный Job и root gate, не завершают старые процессы сами.
- `--check-package-bootstrap <runtime-root>` — read-only проверка, что инициатор
  находится вне исходного старого Hub Job. Это не остановка и не install grant.

Flags detached/breakaway сами по себе не доказывают независимость от вложенных
Job или дерева вызывающего App. Host проверяет приостановленный child и точный
shell parent до запуска. Изолированная проверка отдельно завершает только свои
Job и surrogate caller tree через `/T`; live Hub/App она не затрагивает.
Проверка перед Resume не запрещает будущему внешнему процессу назначить новый Job.

Пакетный handoff ждёт выход удерживаемых old Node/Host handles, освобождает свои
process references, затем подтверждает нулевой ActiveProcesses через ТОТ ЖЕ Job
handle. Перед backup/install/launch Node повторно запрашивает доказательство у
удерживающего Job native parent. Потеря ответа — UNKNOWN, не повторный запуск.
После обновления новый Host принимает только одно exact launch intent. Режим
`--check` не расходует это право и не запускает приложение.

Сборка не требует отдельного SDK: используется системный
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` с fallback на x86.
