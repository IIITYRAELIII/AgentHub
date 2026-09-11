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
- `--spawn-independent` — через Windows Management Instrumentation создать
  независимый экземпляр Runtime Host для безопасного рестарта.

Сборка не требует отдельного SDK: используется системный
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` с fallback на x86.
