# Agent Hub File Bridge

Обычный Web Clipboard API не умеет помещать произвольный файл в Windows
clipboard как объект Проводника. File Bridge регистрирует локальный протокол
`agenthub-file://`, получает один файл по короткоживущему одноразовому билету и
выполняет `CF_HDROP` либо открывает скачанный файл в Проводнике удалённого
Windows-компьютера.

Сначала сопрягите браузер как доверенное устройство. Затем скачайте
`/api/workspace-file/bridge-installer.ps1` с HTTPS-адреса Hub и выполните:

```powershell
powershell -ExecutionPolicy Bypass -File .\AgentHub-FileBridge-install.ps1 -HubOrigin https://hub.example.com
```

Адрес закрепляется в локальной конфигурации. Bridge принимает только HTTPS URL
этого origin и только путь одноразового билета Agent Hub. Файлы сохраняются в
`%LOCALAPPDATA%\AgentHub\FileClipboardCache`; каталоги старше семи дней удаляются
при следующем вызове, одновременно сохраняются не более восьми последних файлов.

Удаление:

```powershell
powershell -ExecutionPolicy Bypass -File .\AgentHub-FileBridge-install.ps1 -Uninstall
```
