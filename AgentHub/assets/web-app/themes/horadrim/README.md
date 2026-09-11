# Архив Хорадримов

Отдельная тема по выбранному концепту №7: тёмные каменные подложки,
старое золото, геометрические рамки и библиотека при свечах.

## Использование

Настройки → Тема → Архив Хорадримов. Фоны: «Библиотека Хорадримов»
и «Тёмный архив» без изображения, а также шесть сюжетных вариантов ниже. Регистрация через штатный theme-registry.

## Состав

- theme.json — каталог, точные URL ресурсов и восемь фонов.
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

В браузере: выбор темы/всех фонов, диалоги и Dashboard, цитаты, ввод и фокус
композера, desktop и mobile, отсутствие ошибок и переполнения.

## Prompt фона — встроенный ImageGen

Use case: stylized-concept. Generate a finished full-bleed landscape wallpaper ONLY, no application UI. Reference image is mood, materials and world reference for its ancient Horadrim library; remove ALL panels, frames, lettering and symbols belonging to UI. Diablo-inspired dark ancient scholarly archive, tall shelves of worn leather-bound books and carved warm-black stone pillars at far left and right edges, small groups of candles near outer edges, a brass armillary sphere and a few stacked manuscripts confined to bottom-left corner. Center 60% is nearly black low-contrast empty darkness, minimal detail, suitable behind text. Very dark black-umber, aged brass and muted amber highlights, subtle warm dust haze. Cinematic painterly realism, tactile but calm, sophisticated ancient library. No people, skulls, monsters, green, pink, neon, bright parchment, readable text, logos, watermarks, interface elements, decorative borders. Landscape 16:9, requested 2560x1440.


## Дополнительные фоны

Все шесть созданы встроенным ImageGen; исходные PNG включены без преобразования.
Композер сохраняет декоративные углы без стандартной прямоугольной обводки;
у центральной панели убрана лишняя внешняя линия.

### Хранилище камня душ

[soulstone-vault.png](soulstone-vault.png), 1672×941.

Use case: stylized-concept. Production wallpaper for a dark Horadrim Archive chat theme, full-bleed landscape 16:9, requested 2560x1440. Cinematic painterly realism, warm black and umber, aged muted gold. Center 60 percent remains nearly black with very low detail for readable chat; subjects and highlights concentrated at outer sides and lower corners. No UI, no text, no logos, no watermarks, no ornamental picture border, no people, no green or pink, no bright central light. Ancient black-stone vault. A small dull crimson soulstone crystal held within aged golden containment rings on the far left, geometric seals carved into stone nearby, faint dust in warm-black air. Sparse dim glints, mysterious solemn darkness.

### Зал Печатей

[hall-of-seals.png](hall-of-seals.png), 1672×941.

Use case: stylized-concept. Production wallpaper for a dark Horadrim Archive chat theme, full-bleed landscape 16:9, requested 2560x1440. Cinematic painterly realism, warm black and umber, aged muted gold. Center 60 percent remains nearly black with very low detail for readable chat; subjects and highlights concentrated at outer sides and lower corners. No UI, no text, no logos, no watermarks, no ornamental picture border, no people, no green or pink, no bright central light. An immense ancient stone sealed doorway offset to the far right. Geometrically engraved slabs, thin muted warm light escaping narrow cracks at the edge of the door. Large dark blank weathered stone surface across center. Scholarly sacred architecture, restrained gold inlays.

### Стол Хорадрима

[horadrim-desk.png](horadrim-desk.png), 1672×941.

Use case: stylized-concept. Production wallpaper for a dark Horadrim Archive chat theme, full-bleed landscape 16:9, requested 2560x1440. Cinematic painterly realism, warm black and umber, aged muted gold. Center 60 percent remains nearly black with very low detail for readable chat; subjects and highlights concentrated at outer sides and lower corners. No UI, no text, no logos, no watermarks, no ornamental picture border, no people, no green or pink, no bright central light. Top-down view of an ancient scholar's dark wooden desk. Open worn folio with indistinct illegible marks at lower left, brass dividers and astronomical instruments along right edge, rolled scrolls and a few candle stubs at outer corners. Central desk is empty nearly black wood; paper dark aged brown, never bright white.

### Погребённый архив

[buried-archive.png](buried-archive.png), 1672×941.

Use case: stylized-concept. Production wallpaper for a dark Horadrim Archive chat theme, full-bleed landscape 16:9, requested 2560x1440. Cinematic painterly realism, warm black and umber, aged muted gold. Center 60 percent remains nearly black with very low detail for readable chat; subjects and highlights concentrated at outer sides and lower corners. No UI, no text, no logos, no watermarks, no ornamental picture border, no people, no green or pink, no bright central light. A forgotten library buried beneath desert sands. Sand-covered steps and broken warm-black stone columns along sides, partly buried book niches at far left, sparse faint amber shafts of dusty light only near outer edges. Central aisle dissolves into near-black shadow. Darkness dominates, sand muted dark ochre.

### Пепел Тристрама

[tristram-ashes.png](tristram-ashes.png), 1672×941.

Use case: stylized-concept. Production wallpaper for a dark Horadrim Archive chat theme, full-bleed landscape 16:9, requested 2560x1440. Cinematic painterly realism, warm black and umber, aged muted gold. Center 60 percent remains nearly black with very low detail for readable chat; subjects and highlights concentrated at outer sides and lower corners. No UI, no text, no logos, no watermarks, no ornamental picture border, no people, no green or pink, no bright central light. Charred ancient bookcases and blackened wooden beams confined to both far sides, soot-coated fragments of books, a few tiny dark orange embers at bottom corners, almost imperceptible drifting ash. Center is calm velvety warm-black shadow. Melancholy aftermath, no flames or bright smoke.

### Обсидиан и золото

[obsidian-gold.png](obsidian-gold.png), 1672×941.

Use case: stylized-concept. Production wallpaper for a dark Horadrim Archive chat theme, full-bleed landscape 16:9, requested 2560x1440. Cinematic painterly realism, warm black and umber, aged muted gold. Center 60 percent remains nearly black with very low detail for readable chat; subjects and highlights concentrated at outer sides and lower corners. No UI, no text, no logos, no watermarks, no ornamental picture border, no people, no green or pink, no bright central light. Abstract restrained material wallpaper, matte warm-black obsidian surface. A few fine physically engraved muted gold geometric lines on outer edges and lower corners only, very subtle stone grain. Quiet center almost uniformly black, no depicted room or objects, no central emblem, no continuous border. Elegant aged crafted material, not a sci-fi circuit board.
