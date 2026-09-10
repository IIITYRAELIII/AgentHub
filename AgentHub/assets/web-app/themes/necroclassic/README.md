# Некроклассика

«Классика, которую подняли из мёртвых»: пепельно-серые панели,
холодный голубой акцент и призрачный дым на периферии экрана.
Композер обрамлён тонкой голубой линией с мягким свечением;
при фокусе внутри композера рамка становится ярче без изменения размеров.
Внутри верхних углов композера расположена угловатая SVG-гравировка с тёмными
бороздами и потёртым серебром. Полоса над вводом оставляет место орнаменту;
при фокусе он немного проявляется без изменения размеров. Заголовки боковых
панелей оформлены ступенчатым геометрическим разделителем. Декор не перехватывает мышь.

Выбор: **Настройки → Тема оформления → Некроклассика**.
Фон **Призрачный пепел** содержит статичное изображение дыма;
**Тихий пепел** оставляет ровный тёмно-серый фон. Общие настройки фона
и прозрачности чата сохраняют своё обычное поведение.

Дополнительные сцены в **Настройки → Фон интерфейса**:

- **Пепельный туман** — слои холодного дыма на графитовом фоне.
- **Холодный камень** — тёмные каменные плоскости с ледяным светом по краям.
- **Холодное затмение** — тёмная луна с голубой короной у края экрана.

Подложки сообщений и карточек имеют мягкий серый градиент и тонкий светлый
верхний край. Цитаты в сообщениях и композере выглядят утопленными и отмечены
голубой линией; существующие переходы к источнику и клавиатурный фокус сохранены.

Пакет использует общую компоновку, фирменный знак и существующие иконки Hub.
Переписка, цитаты и задачи остаются живыми компонентами с плотными подложками;
фон не перехватывает ввод. Новых скриптов, шрифтов из сети и анимаций нет.
Тема автоматически обнаруживается общим реестром на Web, VS Code и Worker.

Проверки из AgentHub:

```powershell
node --test tests/public/theme-registry.test.mjs
node --test tests/interfaces/web/mini-app-server.test.mjs
node --test VSCodeExtension/render.test.js
```

Растровый фон создан через ImageGen для выбранного концепта «Veil of Ash».

## Промпты дополнительных фонов

Generated with the built-in ImageGen tool, one independent generation per asset. Outputs copied unchanged; source originals retained. Requested 2560×1440; actual output for each is 1672×941. No postprocessing.

### ash-mist.png

Use case: stylized-concept. Asset type: final desktop application wallpaper only, 2560x1440 requested, wide 16:9. Primary request: Пепельный туман / Ash Mist, an elegant gloomy fantasy background for a charcoal gray and cold cyan theme called Necroclassic. Layers of softly drifting pale ice-blue smoke and ash mist, delicate wisps emerging from the far left edge and lower left corner, fading naturally into quiet graphite darkness. Almost photographic volumetric vapor with very subtle depth, no busy granular texture. Composition: low-contrast charcoal near #131416 throughout the center 60 percent and right middle, intentionally empty so interface text and cards stay readable. Detailed fog mainly within the left outer quarter and a faint echo in lower right corner, not a centered cloud. Palette: neutral graphite gray, ash silver, restrained blue-cyan #6ac8e0 highlights with predominantly blue hue; no green, teal green, pink, purple, warm gold. Lighting: quiet spectral side light, moody, low key, restrained not neon. No text, no UI, no cards, no frames, no symbols, no logo, no watermark, no people, no faces, no architecture. Full bleed raster wallpaper.

### cold-stone.png

Use case: stylized-concept. Asset type: final desktop application wallpaper only, 2560x1440 requested, wide 16:9. Primary request: Холодный камень / Cold Stone, an elegant gloomy fantasy background for a charcoal gray and cold cyan theme called Necroclassic. Huge quiet planes of dark weathered slate and black basalt with barely visible broad fractured geology. Very thin restrained ice-blue light catches a few deep seams only along the far left edge, bottom left corner and far lower right corner. Composition: center 60 percent and right middle must be almost uniform low-contrast charcoal near #131416, intentionally calm for interface text and cards. No bright seam, object, or diagonal crossing central content area. Stone detail softly disappears into darkness instead of a repetitive texture. Materials feel heavy, ancient, matte, softly eroded with fine natural surface variation. Palette: neutral graphite gray, slate, tiny cold blue-cyan accents #6ac8e0; no green, pink, purple, warm gold. Lighting: very low key atmospheric grazing light, ominous but sophisticated, restrained not neon or lava. No text, no UI, no cards, no drawn frames, no symbols, no logo, no watermark, no people, no faces, no castles. Full bleed raster wallpaper.

### cold-eclipse.png

Use case: stylized-concept. Asset type: final desktop application wallpaper only, 2560x1440 requested, wide 16:9. Primary request: Холодное затмение / Cold Eclipse, an elegant gloomy fantasy background for a charcoal gray and cold cyan theme called Necroclassic. A very large almost black eclipsed moon is partly outside the far left border. Only its rightmost thin ice-blue rim and dim smoky blue corona arc are visible inside the left outer quarter, fading into infinite charcoal space. Moon center lies beyond the left image edge; the visible arc must not reach past 25 percent of image width. Faint cold haze in lower corners, a barely perceptible sparse star or two near the outermost edges only. Composition: center 60 percent and right middle remain almost uniform low-contrast charcoal near #131416 for interface text and cards; no central bright object or focal point. Mood: somber, quiet, spectral, cinematic low key, ancient dark fantasy rather than busy sci-fi. Palette: neutral graphite gray and black, restrained frost-blue cyan corona #6ac8e0, soft ash gray; no green, pink, purple, warm gold. No neon, no dramatic explosive sun flare, no dense starfield, no giant center moon. No text, no UI, no cards, no frames, no symbols, no logo, no watermark, no people, no faces. Full bleed raster wallpaper.
