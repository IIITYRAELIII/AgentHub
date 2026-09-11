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

- `theme.json` — каталог темы и семи вариантов фона.
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

В браузере: выбор темы и всех фонов, сообщения обоих авторов, цитата,
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

## Дополнительные фоны

Все пять изображений созданы встроенным ImageGen. Оригинальные изображения
сохранены без изменения; PNG входят в пакет темы. Выбор загружает и декодирует
сцену перед переключением (`preload`). Новых скриптов и анимаций нет.

### Красные клёны — `red-maples.png`

Use case: stylized-concept. Asset type: finished full-bleed 16:9 landscape wallpaper for a dark chat application, NOT a UI mockup. Style: cinematic painterly realism, Japanese mountain temple inspired by Sekiro Senpou Temple, ominous and restrained. Palette: warm brown-black, mahogany, aged brass, burnt copper, subtle vermilion; no green, pink, purple or blue cast. Composition crucial: detailed atmospheric scene at the outer edges, central 60 percent remains very dark quiet low-contrast negative space behind text, no central focal object. No interface, lettering, logos, frames, watermark, humans. Wide landscape 2560x1440 requested. Scene: Copper-red autumn maple branches frame both outer edges of an ancient dark wooden veranda; weathered cedar pillars at the sides, sparse fallen red leaves on the dark floor below. Restrained amber edge light reveals leaf veins and lacquered wood. Center opens into deep warm darkness. Rich autumn red, not bright orange daylight.

### Зал тысячи Будд — `thousand-buddhas.png`

Use case: stylized-concept. Asset type: finished full-bleed 16:9 landscape wallpaper for a dark chat application, NOT a UI mockup. Style: cinematic painterly realism, Japanese mountain temple inspired by Sekiro Senpou Temple, ominous and restrained. Palette: warm brown-black, mahogany, aged brass, burnt copper, subtle vermilion; no green, pink, purple or blue cast. Composition crucial: detailed atmospheric scene at the outer edges, central 60 percent remains very dark quiet low-contrast negative space behind text, no central focal object. No interface, lettering, logos, frames, watermark, humans. Wide landscape 2560x1440 requested. Scene: Rows of small ancient Buddhist statues recede into the darkness along both sides of an abandoned temple hall. Carved serene faces and hands with worn dark-gold leaf catching extremely faint warm sidelight, cracked dark wood shelves. Wide central aisle dissolves into nearly black shadows. Monumental, sacred, quietly unsettling; no bright central statue.

### Пепел благовоний — `incense-ash.png`

Use case: stylized-concept. Asset type: finished full-bleed 16:9 landscape wallpaper for a dark chat application, NOT a UI mockup. Style: cinematic painterly realism, Japanese mountain temple inspired by Sekiro Senpou Temple, ominous and restrained. Palette: warm brown-black, mahogany, aged brass, burnt copper, subtle vermilion; no green, pink, purple or blue cast. Composition crucial: detailed atmospheric scene at the outer edges, central 60 percent remains very dark quiet low-contrast negative space behind text, no central focal object. No interface, lettering, logos, frames, watermark, humans. Wide landscape 2560x1440 requested. Scene: Minimal quiet dark sanctuary. A small aged bronze incense burner sits in the lower-left outer corner, a single dim ember with fine ash. Thin natural wisps of warm gray smoke drift along the left edge and fade before reaching center. Matte brown-black emptiness over most of the frame, faint tactile wood at bottom. Extremely restrained sparse detail, no luminous smoke.

### Врата в тумане — `mist-gates.png`

Use case: stylized-concept. Asset type: finished full-bleed 16:9 landscape wallpaper for a dark chat application, NOT a UI mockup. Style: cinematic painterly realism, Japanese mountain temple inspired by Sekiro Senpou Temple, ominous and restrained. Palette: warm brown-black, mahogany, aged brass, burnt copper, subtle vermilion; no green, pink, purple or blue cast. Composition crucial: detailed atmospheric scene at the outer edges, central 60 percent remains very dark quiet low-contrast negative space behind text, no central focal object. No interface, lettering, logos, frames, watermark, humans. Wide landscape 2560x1440 requested. Scene: Ancient Japanese Buddhist mountain temple wooden gate set off-center near the left edge, silhouette and roof partly lost in dim milky fog; rough umber stones and worn steps along bottom outer edges. One very dim amber lantern near the right edge. Deep soot-brown low-contrast mist darkens toward the central area. Cooler neutral ivory-gray atmosphere but no blue cast, no bright white fog filling the center.

### Запретный зал — `forbidden-hall.png`

Use case: stylized-concept. Asset type: finished full-bleed 16:9 landscape wallpaper for a dark chat application, NOT a UI mockup. Style: cinematic painterly realism, Japanese mountain temple inspired by Sekiro Senpou Temple, ominous and restrained. Palette: warm brown-black, mahogany, aged brass, burnt copper, subtle vermilion; no green, pink, purple or blue cast. Composition crucial: detailed atmospheric scene at the outer edges, central 60 percent remains very dark quiet low-contrast negative space behind text, no central focal object. No interface, lettering, logos, frames, watermark, humans. Wide landscape 2560x1440 requested. Scene: A forbidden inner temple chamber: near the right edge a heavy weathered mahogany door slightly ajar with a very narrow amber light slit; at left edge hang damaged old scrolls with faded cinnabar abstract stains, no readable lettering. Dark wood grain and old brass fittings barely visible, brown-black center. Secretive, tense, quiet. No people, no magical runes.
