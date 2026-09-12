# Бестиарий

Тема по концепту 7 из HUB-217. Ответы лежат на общей тёмной странице; пользовательские сообщения отмечены красной полосой. Georgia используется только для текста переписки и заголовков; код остаётся моноширинным. Рисунок грифона находится на правом поле фона.

Выбор: Настройки → Интерфейс → Тема → Бестиарий. Фоны: «Грифон на полях» и «Чистый пергамент». Штатный выбор «Нет» также работает.

Пакет обнаруживается theme-registry автоматически. Состояние, владельцы сообщений, порядок, ссылки, вложения и действия остаются общими (UI-001). Нет правок JS/HTML, миграций, новых фраз в интерфейсе и вымышленных цитат из концепта.

Материалы: background.png создан встроенным ImageGen; paper-grain.svg — локальная SVG-фактура. PNG сохранён без обработки. Исходный concept — ориентир, не готовая верстка: сохранены штатные панели и их компоновка.

## Проверка

Пройдено 10 тестов theme-registry. В headless Edge проверены настоящий index.html/app.js
с синтетическими сообщениями, переключение темы, фон и тихий вариант, фокус/ввод в
композере, переход Dashboard → Диалоги, размеры 1800×1100 и 390×844.
Пять сообщений остаются пятью; горизонтального переполнения и ошибок страницы нет.
Код, списки, цитаты и декоративные слои осмотрены на скриншотах. Серверная отправка
и реальные провайдеры этой визуальной проверкой не тестируются.

## Промпт ImageGen

Use case: illustration-story. Production background asset for a dark Witcher bestiary chat UI, NOT a screenshot. 2560x1440 landscape. A nearly black warm umber ancient vellum surface, subtle organic grain across the whole canvas. Very fine aged ochre ink anatomical drawing of a griffin ONLY along the far RIGHT edge, occupying rightmost 18% and lower 65%, bird head, feathers, lion foreleg and claws, precise elegant naturalist copperplate engraving. Left edge a very narrow dark leather book binding, worn seams. Central 75% is completely empty dark brown paper #201b15, calm enough for pale text to be placed on top. Keep drawing faint and subdued, no bright illumination. No text, no symbols, no UI, no cards, no lettering, no watermark. Mature Witcher field bestiary mood, tactile realistic paper and hand-etched ink, not cartoon, not green.
