"use strict";

const crypto = require("node:crypto");

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
      flex: 0 1 auto;
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

    #work-log-content > h1 > .rate-limits {
      flex: 0 1 auto;
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

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function webviewHtml(webview, theme = "orbit", themeCatalog = [{ id: "orbit", name: "Орбита" }]) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const catalog = themeCatalog.filter((item) => /^[a-z][a-z0-9-]{0,63}$/u.test(item?.id) && item?.name);
  const availableThemes = catalog.length ? catalog : [{ id: "orbit", name: "Орбита" }];
  const themeIds = availableThemes.map((item) => item.id);
  const initialTheme = themeIds.includes(theme)
    ? theme
    : "orbit";
  const pickerMarkup = '<span class="theme-picker-label">Тема</span>'
    + '<select data-theme-select aria-label="Тема оформления">'
    + availableThemes.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("")
    + "</select>";
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
    const themes = new Set(${JSON.stringify(themeIds)});
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
      picker.innerHTML = ${JSON.stringify(pickerMarkup)};
      picker.querySelector('select').addEventListener('change', (event) => {
        applyTheme(event.target.value);
      });
      const collapseAll = document.createElement('button');
      collapseAll.className = 'refresh collapse-all';
      collapseAll.type = 'button';
      collapseAll.setAttribute('data-collapse-all', '');
      collapseAll.title = 'Свернуть всё';
      collapseAll.textContent = 'Свернуть всё';
      const sourceLimits = content.querySelector('[data-work-log-rate-limits]');
      const rateLimits = document.createElement('div');
      rateLimits.className = 'rate-limits';
      if (sourceLimits) {
        const sampledAt = new Date(sourceLimits.getAttribute('data-sampled-at') || '');
        rateLimits.title = Number.isNaN(sampledAt.getTime())
          ? ''
          : 'Лимиты на ' + sampledAt.toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            });
        rateLimits.replaceChildren(...sourceLimits.childNodes);
        sourceLimits.remove();
      } else {
        rateLimits.hidden = true;
      }
      heading.append(rateLimits, collapseAll, picker);
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

module.exports = { baseCss, panelCss, webviewHtml };
