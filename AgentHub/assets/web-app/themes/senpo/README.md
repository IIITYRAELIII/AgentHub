# Храм Сэмпо

Отдельная тёмная тема по выбранному концепту «Ночной лак»: махагон,
потемневшая латунь, киноварные метки выбора и тёплый свет ночного храма.
Основная поверхность — диалоги; те же токены оформляют Dashboard, журнал,
статистику и настройки. Компоновка остаётся `shared`.

## Использование

После применения сборки выберите `Настройки → Тема → Храм Сэмпо`.
Фон `Ночной храм` содержит пейзаж; `Тёмный лак` оставляет спокойную заливку.
Код ядра не требует регистрации: пакет обнаруживается общим реестром тем.

## Состав и ограничения

- `theme.json` — каталог темы и двух вариантов фона.
- `theme.css` — палитра, материалы, сообщения, цитаты и рамка композера.
- `brass-frame.svg` — симметричная рамка с небольшими угловыми вставками;
  масштабируется через девять секций, не перехватывает клики.
- `night-temple.png` — фон, созданный встроенным ImageGen по выбранному
  пользователем концепту; центр оставлен тёмным для читаемости.

Пакет не меняет логотип, порядок или идентичность сообщений, статусы,
обработчики действий, транспорт, сохранённые предпочтения пользователя
либо геометрию общей desktop-оболочки. Собственных анимаций и скриптов нет.
Изменения текста и дополнительные элементы из иллюстративного концепта
не переносятся в продукт.

## Проверка

Из корня AgentHub:

```sh
node --test tests/public/theme-registry.test.mjs tests/interfaces/web/mini-app-server.test.mjs
node --test VSCodeExtension/render.test.js
```

В браузере: выбор темы и обоих фонов, сообщения обоих авторов, цитата,
фокус и ввод в композере, настройки, Dashboard и узкий экран.
Контракт `UI-001` сохранён: тема оформляет существующую проекцию без её изменения.

## Prompt фона (встроенный ImageGen)

Final application wallpaper only, full bleed landscape. A silent dark Japanese
wooden mountain temple veranda at night in autumn, inspired by Senpou Temple.
Weathered reddish-brown cedar pillars confined to the outer left and right
edges; small dim amber lantern at lower left and tiny distant lantern at lower
right. Burnt-copper maple foliage at the periphery, wet mahogany floorboards
and faint incense haze near the bottom. Central 65 percent is calm brown-black
negative space with no focal object. Palette: black cherry wood, deep warm
brown, sparse old brass and amber highlights. Quietly ominous cinematic
painterly realism. No people, statues, logos, text, interface, frames, kanji,
watermarks, neon, gray/blue cast, green, pink or purple. Reference: selected
third «Ночной лак» interface concept, used only for atmosphere and palette.
