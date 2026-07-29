"use strict";

const crypto = require("node:crypto");

const MARK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 2.7 20 7.2v9.6L12 21.3 4 16.8V7.2z"></path>
      <path d="M7.6 12.1h2.2l1.3-2.9 1.9 5.4 1.2-2.5h1.9"></path>
    </svg>`;

/* Панель намеренно остаётся тёмной независимо от темы VS Code: она повторяет
   оформление Mini App журнала. Базовый слой работает и до загрузки файлов CSS. */
function baseCss() {
  return `
    :root { color-scheme: dark; }
    html { background: #080b11; }
    body {
      background: #080b11;
      color: #e9eff8;
      font-family: system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, sans-serif;
      font-size: 15px;
      line-height: 1.45;
      margin: 0;
      padding: 0;
    }
    a { color: #6cb2ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .work-log-empty {
      color: #8797ab;
      padding: 2.5rem 1rem;
      text-align: center;
    }
  `;
}

/* Накладывается последним, поверх work-log.css и стилей Mini App. */
function panelCss() {
  return `
    :root { --header-height: 2.95rem; }

    main { padding-top: 0; }

    #work-log-content > h1 {
      align-items: center;
      backdrop-filter: blur(18px) saturate(150%);
      background: color-mix(in srgb, var(--bg) 88%, transparent);
      border-bottom: 1px solid var(--line);
      display: flex;
      font-family: var(--font-title);
      font-size: 1.1rem;
      font-weight: var(--display-weight);
      gap: 0.6rem;
      letter-spacing: var(--display-spacing);
      margin: 0 calc(var(--gutter-right) * -1) 1rem calc(var(--gutter-left) * -1);
      overflow: visible;
      padding: 0.65rem var(--gutter-right) 0.65rem var(--gutter-left);
      position: sticky;
      text-overflow: clip;
      top: 0;
      white-space: normal;
      z-index: 15;
    }

    #work-log-content > h1 > [data-work-log-panel-title] {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: var(--display-shadow);
      text-transform: var(--display-transform);
      white-space: nowrap;
    }

    #work-log-content > h1 > .theme-picker {
      flex: 0 0 auto;
      font-family: system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", sans-serif;
      font-size: 0.76rem;
      font-weight: 450;
      letter-spacing: 0;
      margin-left: auto;
      text-transform: none;
    }

    #work-log-content > h1 > [data-collapse-all] {
      flex: 0 0 auto;
    }

    #work-log-content > h1::before {
      background: var(--brand-gradient);
      border: 1px solid var(--accent-line);
      border-radius: calc(var(--radius-md) - 2px);
      box-shadow: var(--brand-shadow);
      content: "";
      flex: 0 0 auto;
      height: 1.45rem;
      width: 1.45rem;
    }

    .work-log-empty {
      border: 1px dashed var(--line-strong);
      border-radius: var(--radius-lg);
      color: var(--text-muted);
      margin: 1rem 0;
    }
  `;
}

function webviewHtml(webview, theme = "orbit") {
  const nonce = crypto.randomBytes(16).toString("hex");
  const initialTheme = ["orbit", "nebula", "pulsar", "gothic", "blackhole", "taiga", "magma", "storm"].includes(theme)
    ? theme
    : "orbit";
  // фон темы BlackHole — файл workspace, его адрес выдаёт сам webview
  const imageSources = [webview?.cspSource, "data:"].filter(Boolean).join(" ");
  return `<!DOCTYPE html>
<html lang="ru" data-theme="${initialTheme}" data-surface="desktop">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style id="work-log-style">${baseCss()}</style>
</head>
<body>
  <main id="work-log-content" class="journal"><div class="work-log-empty">Загрузка журнала…</div></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('work-log-content');
    const style = document.getElementById('work-log-style');
    const themes = new Set(['orbit', 'nebula', 'pulsar', 'gothic', 'blackhole', 'taiga', 'magma', 'storm']);
    const persistedState = vscode.getState() || {};
    let journalRendered = false;
    let hasPersistedOpenState =
      persistedState.journalStateVersion === 1 && Array.isArray(persistedState.openDetails);

    function applyTheme(value, persist = true) {
      const theme = themes.has(value) ? value : 'orbit';
      document.documentElement.dataset.theme = theme;
      if (persist) {
        vscode.setState({ ...(vscode.getState() || {}), theme });
        vscode.postMessage({ type: 'theme', theme });
      }
      const select = document.querySelector('[data-theme-select]');
      if (select) select.value = theme;
    }

    function installHeaderControls(titleText) {
      const heading = content.querySelector(':scope > h1');
      if (!heading) return;
      const title = document.createElement('span');
      title.setAttribute('data-work-log-panel-title', '');
      title.textContent = titleText || heading.textContent;
      heading.replaceChildren(title);
      const picker = document.createElement('label');
      picker.className = 'theme-picker';
      picker.innerHTML =
        '<span class="theme-picker-label">Тема</span>' +
        '<select data-theme-select aria-label="Тема оформления">' +
          '<option value="orbit">Орбита</option>' +
          '<option value="nebula">Туманность</option>' +
          '<option value="pulsar">Пульсар</option>' +
          '<option value="gothic">Gothic</option>' +
          '<option value="blackhole">BlackHole</option>' +
          '<option value="taiga">Тайга</option>' +
          '<option value="magma">Магма</option>' +
          '<option value="storm">Гроза</option>' +
        '</select>';
      picker.querySelector('select').addEventListener('change', (event) => {
        applyTheme(event.target.value);
      });
      const collapseAll = document.createElement('button');
      collapseAll.className = 'refresh collapse-all';
      collapseAll.type = 'button';
      collapseAll.setAttribute('data-collapse-all', '');
      collapseAll.title = 'Свернуть всё';
      collapseAll.textContent = 'Свернуть всё';
      heading.append(picker, collapseAll);
      applyTheme(document.documentElement.dataset.theme, false);
    }

    function detailsKey(element, index) {
      if (element.hasAttribute('data-work-log-day-section')) {
        return 'day:' + (element.querySelector(':scope > summary strong')?.textContent || index);
      }
      const turn = element.closest('[data-work-log-turn-id]');
      if (turn) return 'turn:' + turn.getAttribute('data-work-log-turn-id');
      const row = element.closest('[data-work-log-row]');
      const thread = row?.getAttribute('data-work-log-thread-id') || index;
      if (element.hasAttribute('data-work-log-previous-turns')) return 'previous:' + thread;
      if (element.hasAttribute('data-task-usage-details')) return 'usage:' + thread;
      return 'details:' + index;
    }

    function snapshotOpenDetails() {
      return new Set([...content.querySelectorAll('details')].flatMap(
        (element, index) => element.open ? [detailsKey(element, index)] : []
      ));
    }

    function restoreOpenDetails(keys) {
      [...content.querySelectorAll('details')].forEach((element, index) => {
        element.open = keys.has(detailsKey(element, index));
      });
    }

    function persistOpenDetails() {
      const state = vscode.getState() || {};
      vscode.setState({
        ...state,
        journalStateVersion: 1,
        openDetails: [...snapshotOpenDetails()],
      });
      hasPersistedOpenState = true;
    }

    function collapseAllDetails() {
      for (const element of content.querySelectorAll('details[open]')) {
        element.open = false;
      }
      persistOpenDetails();
    }

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'theme') {
        applyTheme(event.data.theme, false);
        return;
      }
      if (event.data?.type !== 'render') return;
      const savedState = vscode.getState() || {};
      const open = journalRendered
        ? snapshotOpenDetails()
        : hasPersistedOpenState
          ? new Set(savedState.openDetails)
          : null;
      const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
      content.innerHTML = event.data.html;
      style.textContent = ${JSON.stringify(baseCss())} + '\\n' + event.data.css;
      installHeaderControls(event.data.title);
      if (open) restoreOpenDetails(open);
      journalRendered = true;
      persistOpenDetails();
      window.scrollTo(0, scrollTop);
    });

    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-collapse-all]')) {
        event.preventDefault();
        collapseAllDetails();
        return;
      }
      const collapse = event.target.closest('[data-work-log-collapse-turns]');
      if (collapse) {
        event.preventDefault();
        event.stopPropagation();
        const row = collapse.closest('[data-work-log-row]');
        const previous = row?.querySelector('details[data-work-log-previous-turns]');
        if (previous) previous.open = false;
        persistOpenDetails();
        return;
      }
      const link = event.target.closest('a[href]');
      if (!link) return;
      event.preventDefault();
      vscode.postMessage({ type: 'open-link', href: link.getAttribute('href') });
    });

    document.addEventListener('toggle', () => {
      if (journalRendered) setTimeout(persistOpenDetails, 0);
    }, true);

    applyTheme(document.documentElement.dataset.theme || vscode.getState()?.theme || 'orbit', false);
  </script>
</body>
</html>`;
}

function sidebarHtml(webview) {
  const nonce = crypto.randomBytes(16).toString("hex");
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    /* Компактное отражение палитр Mini App, чтобы боковая панель, панель
       журнала и Telegram-версия читались как одно оформление. */
    :root {
      --line: rgba(150, 178, 214, 0.14);
      --line-strong: rgba(150, 178, 214, 0.26);
      --text: #e9eff8;
      --text-muted: #8797ab;
      --accent: #6cb2ff;
      --accent-line: rgba(108, 178, 255, 0.42);
      --card-glow: rgba(108, 178, 255, 0.16);
      --card-bg: linear-gradient(180deg, rgba(16, 22, 31, 0.96), rgba(10, 14, 20, 0.96));
      --mark-bg: linear-gradient(150deg, rgba(108, 178, 255, 0.28), rgba(126, 78, 190, 0.22));
      --radius-card: 14px;
      --radius-mark: 10px;
      --radius-button: 999px;
      --title-font: inherit;
      --title-transform: none;
      --title-spacing: -0.015em;
    }

    html[data-theme="nebula"] {
      --line: rgba(214, 168, 255, 0.13);
      --line-strong: rgba(224, 186, 255, 0.24);
      --text: #f6ecff;
      --text-muted: #ac98be;
      --accent: #d79bff;
      --accent-line: rgba(215, 155, 255, 0.42);
      --card-glow: rgba(215, 155, 255, 0.2);
      --card-bg: linear-gradient(158deg, rgba(70, 30, 110, 0.96), rgba(20, 9, 34, 0.96));
      --mark-bg: linear-gradient(150deg, rgba(196, 106, 255, 0.4), rgba(72, 96, 255, 0.3));
      --radius-card: 20px;
      --radius-mark: 14px;
      --title-spacing: 0.005em;
    }

    html[data-theme="pulsar"] {
      --line: rgba(74, 226, 214, 0.24);
      --line-strong: rgba(74, 226, 214, 0.42);
      --text: #e2fbf8;
      --text-muted: #74a9a5;
      --accent: #3ce6d4;
      --accent-line: rgba(60, 230, 212, 0.55);
      --card-glow: rgba(60, 230, 212, 0.14);
      --card-bg: linear-gradient(180deg, rgba(6, 32, 38, 0.96), rgba(3, 19, 24, 0.96));
      --mark-bg: linear-gradient(150deg, rgba(60, 230, 212, 0.32), rgba(16, 92, 120, 0.4));
      --radius-card: 4px;
      --radius-mark: 3px;
      --radius-button: 2px;
      --title-transform: uppercase;
      --title-spacing: 0.12em;
    }

    html[data-theme="gothic"] {
      --line: rgba(190, 199, 208, 0.2);
      --line-strong: rgba(206, 214, 222, 0.32);
      --text: #e0e4e8;
      --text-muted: #8d939a;
      --accent: #c2c9d0;
      --accent-line: rgba(194, 201, 208, 0.42);
      --card-glow: rgba(226, 232, 240, 0.05);
      --card-bg:
        radial-gradient(46% 60% at 18% 22%, rgba(226, 232, 240, 0.055), transparent 74%),
        radial-gradient(42% 56% at 82% 78%, rgba(0, 0, 0, 0.38), transparent 76%),
        linear-gradient(176deg, #26292b 0, #1c1e20 46%, #141516 100%);
      --mark-bg:
        radial-gradient(64% 70% at 30% 26%, rgba(226, 232, 240, 0.14), transparent 74%),
        linear-gradient(176deg, #34383c, #131416);
      --radius-card: 3px;
      --radius-mark: 2px;
      --radius-button: 2px;
      --title-font: "Perpetua Titling MT", "Felix Titling", "Palatino Linotype", Georgia, serif;
      --title-transform: uppercase;
      --title-spacing: 0.07em;
    }

    html[data-theme="blackhole"] {
      --line: rgba(226, 236, 255, 0.13);
      --line-strong: rgba(226, 236, 255, 0.26);
      --text: #f2f6fd;
      --text-muted: #8a93a5;
      --accent: #9ecbff;
      --accent-line: rgba(158, 203, 255, 0.42);
      --card-glow: rgba(96, 176, 255, 0.18);
      --card-bg: linear-gradient(180deg, rgba(6, 8, 12, 0.98), rgba(0, 0, 0, 0.99));
      --mark-bg: radial-gradient(circle at 50% 50%, #000 0 38%, rgba(150, 205, 255, 0.9) 48%, rgba(70, 140, 255, 0.45) 70%, #000 100%);
      --radius-card: 18px;
      --radius-mark: 999px;
      --radius-button: 999px;
      --title-spacing: 0.02em;
    }

    html[data-theme="taiga"] {
      --line: rgba(150, 186, 220, 0.13);
      --line-strong: rgba(150, 186, 220, 0.26);
      --text: #e6eef7;
      --text-muted: #8695a8;
      --accent: #93bcd6;
      --accent-line: rgba(147, 188, 214, 0.4);
      --card-glow: rgba(109, 155, 183, 0.14);
      --card-bg: linear-gradient(180deg, rgba(11, 17, 26, 0.96), rgba(5, 9, 15, 0.98));
      --mark-bg: linear-gradient(145deg, rgba(147, 188, 214, 0.2), rgba(7, 12, 18, 0.92));
      --radius-card: 18px;
      --radius-mark: 12px;
      --radius-button: 999px;
      --title-spacing: -0.005em;
    }

    html[data-theme="magma"] {
      --line: rgba(226, 168, 128, 0.14);
      --line-strong: rgba(232, 178, 140, 0.28);
      --text: #f1e7e0;
      --text-muted: #9c8b81;
      --accent: #ff9a5c;
      --accent-line: rgba(255, 154, 92, 0.4);
      --card-glow: rgba(255, 138, 61, 0.16);
      --card-bg: linear-gradient(180deg, rgba(20, 11, 8, 0.96), rgba(9, 5, 4, 0.98));
      --mark-bg: linear-gradient(145deg, rgba(255, 154, 92, 0.24), rgba(12, 6, 5, 0.94));
      --radius-card: 10px;
      --radius-mark: 6px;
      --radius-button: 999px;
      --title-spacing: -0.012em;
    }

    html[data-theme="storm"] {
      --line: rgba(160, 190, 230, 0.14);
      --line-strong: rgba(170, 200, 240, 0.29);
      --text: #e8eefa;
      --text-muted: #8e9bb0;
      --accent: #9db4ff;
      --accent-line: rgba(157, 180, 255, 0.42);
      --card-glow: rgba(157, 180, 255, 0.15);
      --card-bg: linear-gradient(180deg, rgba(15, 22, 34, 0.96), rgba(6, 10, 17, 0.98));
      --mark-bg: linear-gradient(145deg, rgba(157, 180, 255, 0.22), rgba(8, 12, 20, 0.94));
      --radius-card: 12px;
      --radius-mark: 9px;
      --radius-button: 999px;
      --title-spacing: -0.008em;
    }

    * { box-sizing: border-box; }

    body {
      color: var(--text);
      font-family: var(--vscode-font-family, system-ui), "Segoe UI", sans-serif;
      font-size: 0.82rem;
      margin: 0;
      padding: 0.6rem;
    }

    .card {
      background:
        radial-gradient(120% 80% at 88% -30%, var(--card-glow), transparent 62%),
        var(--card-bg);
      border: 1px solid var(--line);
      border-radius: var(--radius-card);
      box-shadow: 0 18px 38px -28px rgba(0, 0, 0, 0.95);
      padding: 0.85rem 0.8rem 0.75rem;
    }

    .card-head {
      align-items: center;
      display: flex;
      gap: 0.6rem;
      margin-bottom: 0.65rem;
    }

    .mark {
      align-items: center;
      background: var(--mark-bg);
      border: 1px solid var(--accent-line);
      border-radius: var(--radius-mark);
      box-shadow: 0 6px 18px -10px var(--accent);
      color: var(--accent);
      display: flex;
      flex: 0 0 auto;
      height: 2.1rem;
      justify-content: center;
      width: 2.1rem;
    }

    .mark svg { height: 1.15rem; width: 1.15rem; }

    .eyebrow {
      color: var(--text-muted);
      font-family: var(--title-font);
      font-size: 0.6rem;
      font-weight: 700;
      letter-spacing: 0.16em;
      margin: 0;
      opacity: 0.85;
      text-transform: uppercase;
    }

    h2 {
      font-family: var(--title-font);
      font-size: 0.98rem;
      font-weight: 620;
      letter-spacing: var(--title-spacing);
      margin: 0;
      text-transform: var(--title-transform);
    }

    .theme-row {
      align-items: center;
      display: flex;
      gap: 0.35rem;
      margin: 0 0 0.6rem;
    }

    .theme-row span {
      color: var(--text-muted);
      flex: 0 0 auto;
      font-size: 0.72rem;
    }

    .theme-row select {
      appearance: none;
      background:
        linear-gradient(45deg, transparent 50%, var(--accent) 50%) calc(100% - 0.72rem) 50% / 0.28rem 0.28rem no-repeat,
        linear-gradient(135deg, var(--accent) 50%, transparent 50%) calc(100% - 0.52rem) 50% / 0.28rem 0.28rem no-repeat,
        rgba(255, 255, 255, 0.04);
      border: 1px solid var(--line);
      border-radius: var(--radius-button);
      color: var(--text);
      cursor: pointer;
      flex: 1 1 auto;
      font: inherit;
      min-width: 0;
      padding: 0.24rem 1.15rem 0.24rem 0.55rem;
    }

    .theme-row option { background: #101216; color: #e9eff8; }

    .hint {
      color: var(--text-muted);
      line-height: 1.45;
      margin: 0 0 0.75rem;
    }

    .actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }

    button {
      align-items: center;
      border-radius: var(--radius-button);
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      gap: 0.35rem;
      justify-content: center;
      padding: 0.42rem 0.8rem;
      transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
    }

    button svg { height: 0.85rem; width: 0.85rem; }

    .primary {
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--accent) 26%, transparent),
        color-mix(in srgb, var(--accent) 13%, transparent)
      );
      border: 1px solid var(--accent-line);
      color: color-mix(in srgb, var(--accent) 45%, var(--text));
      flex: 1 1 auto;
      font-weight: 600;
    }

    .primary:hover {
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--accent) 38%, transparent),
        color-mix(in srgb, var(--accent) 20%, transparent)
      );
      border-color: color-mix(in srgb, var(--accent) 65%, transparent);
    }

    .ghost {
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid var(--line);
      color: var(--text-muted);
      flex: 0 0 auto;
    }

    .ghost:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--line-strong);
      color: var(--text);
    }

    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* узкая боковая панель: у кнопки обновления остаётся только значок */
    @media (max-width: 215px) {
      .ghost span { display: none; }
      .ghost { padding: 0.42rem 0.6rem; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-head">
      <span class="mark">${MARK_SVG}</span>
      <div>
        <p class="eyebrow">Agent Hub</p>
        <h2>Журнал работ</h2>
      </div>
    </div>
    <p class="hint">Открывается закреплённой вкладкой и обновляется автоматически.</p>
    <label class="theme-row">
      <span>Тема</span>
      <select data-theme-select aria-label="Тема оформления">
        <option value="orbit">Орбита</option>
        <option value="nebula">Туманность</option>
        <option value="pulsar">Пульсар</option>
        <option value="gothic">Gothic</option>
        <option value="blackhole">BlackHole</option>
        <option value="taiga">Тайга</option>
        <option value="magma">Магма</option>
        <option value="storm">Гроза</option>
      </select>
    </label>
    <div class="actions">
      <button id="open" class="primary" type="button">Открыть журнал</button>
      <button id="refresh" class="ghost" type="button" title="Перечитать журнал">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.2 12a8.2 8.2 0 1 1-2.6-6"></path>
          <path d="M20.4 4.6v5.6h-5.6"></path>
        </svg>
        <span>Обновить</span>
      </button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const themes = new Set(['orbit', 'nebula', 'pulsar', 'gothic', 'blackhole', 'taiga', 'magma', 'storm']);
    const select = document.querySelector('[data-theme-select]');

    function applyTheme(value) {
      const theme = themes.has(value) ? value : 'orbit';
      document.documentElement.dataset.theme = theme;
      select.value = theme;
    }

    document.getElementById('open').addEventListener('click', () => {
      vscode.postMessage({ type: 'open' });
    });
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    select.addEventListener('change', () => {
      applyTheme(select.value);
      vscode.postMessage({ type: 'theme', theme: select.value });
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'theme') applyTheme(event.data.theme);
    });

    applyTheme('orbit');
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

module.exports = { MARK_SVG, baseCss, panelCss, sidebarHtml, webviewHtml };
