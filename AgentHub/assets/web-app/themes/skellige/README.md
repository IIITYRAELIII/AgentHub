# Скеллиге

Тема по концепту 9 из HUB-217. Ночная гавань, тёмное дерево, плетение в заголовке левой панели, костяные кромки ответов и деревянный композер с бронзовыми креплениями.

Выбор: Настройки → Интерфейс → Тема → Скеллиге. Фоны: «Ночная гавань» и «Тихое море». Штатный выбор «Нет» также работает.

Все декоративные слои не перехватывают указатель. Кромки масштабируются независимо от высоты сообщения. Композер не обрезается clip-path, чтобы меню и фокус оставались доступными. Штатные геометрия оболочки, функции, идентичности сообщений и состояние не изменены (UI-001). Миграции не нужны.

background.png и timber.png созданы встроенным ImageGen, сохранены без обработки. knotwork.svg и bone-edge.svg — локальные масштабируемые элементы. Рисунок дерева затемнён CSS, чтобы не мешать вводу. Концепт не скопирован целиком: придуманные генератором меню и цитаты не добавлены.

## Проверка

Пройдено 10 тестов theme-registry. В headless Edge проверены настоящий index.html/app.js
с синтетическими сообщениями, переключение темы, фон и тихий вариант, фокус/ввод в
композере, переход Dashboard → Диалоги, размеры 1800×1100 и 390×844.
Пять сообщений остаются пятью; горизонтального переполнения и ошибок страницы нет.
Код, списки, цитаты и декоративные слои осмотрены на скриншотах. Серверная отправка
и реальные провайдеры этой визуальной проверкой не тестируются.

## Промпты ImageGen

### Ночная гавань

Use case: stylized-concept. Production full screen wallpaper for a Skellige-inspired dark Witcher chat UI, NOT a screenshot. 2560x1440 wide landscape. A stormy midnight North Atlantic harbor, steep distant cliffs, a small Viking longship with dark sail along the FAR RIGHT edge, tiny warm lantern in lower right, weathered black timber and coiled rope confined to far left and bottom corners. Midnight navy sea, desaturated steel blue stormclouds, old bronze lantern details. The central 75 percent is almost black navy atmospheric empty mist, very low contrast, completely calm negative space for a dense work application. Detail and lantern confined to outer edges, no central objects. Cinematic hand-painted game environment, tactile and grounded, no snow, no ice palace, no cyan neon, no green, no pink. No lettering, no UI, no logo, no watermark.

### Дерево

Use case: stylized-concept. Production seamless texture tile for a Witcher Skellige wooden interface frame. 1024x1024, flat orthographic close-up of very dark weathered black-brown oak, horizontal fine irregular wood grain, shallow worn pores and a few fine scratches. Realistic old ship timber, matte, subtle gray-brown highlights, overall very dark #1b1814. No boards crossing, no large cracks, no knots, no nailheads, no objects, no perspective, no text, no frame. Even illumination. This is a repeating UI material, grain must stay subtle behind small text. No gradients, no vignette.
