# Agent Hub Mobile

Android-клиент использует тот же опубликованный интерфейс, что Telegram Mini App,
но не зависит от Telegram. Приложение открывает HTTPS Worker Agent Hub и
авторизуется отдельным ключом устройства.

## Защита подключения

- закрытый ключ P-256 создаётся в Android Keystore и не экспортируется;
- HUB выдаёт одноразовый 20-символьный код сопряжения на 10 минут;
- телефон подписывает серверный challenge, после чего получает сессию на 12 часов;
- список устройств, последний доступ и отзыв находятся в общих настройках HUB;
- отзыв немедленно удаляет все активные сессии устройства;
- Telegram-токен, Worker sync secret и локальные пути на телефон не передаются;
- разрешён только HTTPS, ошибки сертификата не обходятся.

Ключ хранится по рекомендациям [Android Keystore](https://developer.android.com/privacy-and-security/keystore),
а Worker проверяет ECDSA P-256 через [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

## Сборка

Требуются JDK 17, Android SDK API 36 и Gradle 8.13. Версии Android Gradle Plugin
и Gradle закреплены в проекте, wrapper содержит SHA-256 официального дистрибутива.

```powershell
pwsh -NoProfile -File AndroidApp/build.ps1 -HubUrl https://hub.example.com
```

Debug APK создаётся в `AndroidApp/app/build/outputs/apk/debug/app-debug.apk`.
Без `HubUrl` адрес можно ввести при первом запуске. Личные URL, ключи телефона и
записи доверенных устройств не хранятся в Git.

## Добавление телефона

1. Откройте общие настройки Agent Hub.
2. В разделе «Доверенные устройства» нажмите «Добавить устройство».
3. Установите APK, укажите HTTPS-адрес и одноразовый код.
4. После сопряжения телефон появится в списке. Кнопка «Отозвать» немедленно
   блокирует дальнейший доступ этого устройства.
