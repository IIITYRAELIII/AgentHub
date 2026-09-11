# Архив Хорадримов

Отдельная тема по выбранному концепту №7: тёмные каменные подложки,
старое золото, геометрические рамки и библиотека при свечах.

## Использование

Настройки → Тема → Архив Хорадримов. Фоны: «Библиотека Хорадримов»
и «Тёмный архив» без изображения. Регистрация через штатный theme-registry.

## Состав

- theme.json — каталог, точные URL ресурсов и два фона.
- theme.css — палитра, подложки и оформление существующих элементов.
- archive-frame.svg / user-frame.svg — симметричные девятисекционные рамки.
- archive-seal.svg — тихая геометрическая гравировка в левой панели.
- stone-grain.svg — статичная процедурная фактура камня.
- archive-library.png — фон, созданный встроенным ImageGen.

Shell shared, геометрия общей оболочки и фирменный знак сохранены.
Нет новых скриптов, обработчиков, данных, аватаров или условных счётчиков
из макета. Декоративные слои не перехватывают события. Все ресурсы локальны,
пакет не зависит от других задач или концептов. UI-001: оформление проекции
без изменения идентичности сообщений. Миграций нет.

## Проверка

Из корня AgentHub:

```sh
node --test tests/public/theme-registry.test.mjs tests/interfaces/web/mini-app-server.test.mjs VSCodeExtension/render.test.js
```

В браузере: выбор темы/обоих фонов, диалоги и Dashboard, цитаты, ввод и фокус
композера, desktop и mobile, отсутствие ошибок и переполнения.

## Prompt фона — встроенный ImageGen

Use case: stylized-concept. Generate a finished full-bleed landscape wallpaper ONLY, no application UI. Reference image is mood, materials and world reference for its ancient Horadrim library; remove ALL panels, frames, lettering and symbols belonging to UI. Diablo-inspired dark ancient scholarly archive, tall shelves of worn leather-bound books and carved warm-black stone pillars at far left and right edges, small groups of candles near outer edges, a brass armillary sphere and a few stacked manuscripts confined to bottom-left corner. Center 60% is nearly black low-contrast empty darkness, minimal detail, suitable behind text. Very dark black-umber, aged brass and muted amber highlights, subtle warm dust haze. Cinematic painterly realism, tactile but calm, sophisticated ancient library. No people, skulls, monsters, green, pink, neon, bright parchment, readable text, logos, watermarks, interface elements, decorative borders. Landscape 16:9, requested 2560x1440.

