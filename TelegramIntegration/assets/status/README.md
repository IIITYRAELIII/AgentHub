# Status headers

`/status` выбирает готовую локальную шапку без обращения к модели:

- `codex-header-01.png` … `codex-header-07.png` — синие технологические варианты Codex;
- `claude-header-01.png` … `claude-header-07.png` — терракотовые редакционные варианты Claude;
- `both-header-01.png` … `both-header-03.png` — совместные варианты для одновременно активных задач обоих агентов.

Фоны созданы встроенной генерацией изображений как панорамы 3:1 без текста и водяных знаков. Основные направления промптов: neural constellation, data aurora, circuit cathedral, quantum grid, dark glass waves, space network и code rain для Codex; paper waves, geometric folds, copper aurora, topographic clay, linen texture, abstract sunrise и particle field для Claude; convergence, split-field fusion и dual-agent orbit для совместных вариантов.

Логотипы наложены локально из исходных `codex-header.png` и `claude-header.png`. Выбор файлов реализован в `status-header.mjs`; повторная генерация и расход токенов при показе статуса не происходят.
