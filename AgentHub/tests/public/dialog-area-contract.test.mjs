import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const assets = new URL("../../assets/web-app/", import.meta.url);

test("dialog area stylesheet is loaded after theme packages", async () => {
  const index = await readFile(new URL("index.html", assets), "utf8");
  assert.ok(index.indexOf("<!-- agent-hub-theme-styles -->") < index.indexOf('href="/dialog-area.css"'));
  assert.match(index, /class="stream-chat-header"[\s\S]*class="chat-scroll"/u);
  assert.match(index, /data-composer-quick-messages/u);
  assert.match(index, /data-stream-header-provider[\s\S]*data-stream-header-model[\s\S]*data-stream-header-message-count/u);
  assert.match(index, /class="chip-button secondary-danger chat-stop-bottom"[^>]*aria-label="Остановить ход"[\s\S]*data-phosphor-icon="stop"/u);
  assert.doesNotMatch(index, /chat-stop-bottom[^>]*>[\s\S]*<span[^>]*>Стоп<\/span>/u);
  assert.match(index, /class="context-usage-bar" data-context-ring/u);
});

test("dialog geometry references semantic tokens without literal colors", async () => {
  const styles = await readFile(new URL("dialog-area.css", assets), "utf8");
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(styles, /\brgba?\(\s*\d/iu);
  assert.match(styles, /--dialog-canvas: var\(--bg\)/u);
  assert.match(styles, /--dialog-agent-2: hsl\(from var\(--accent\) calc\(h \+ 120\) s l\)/u);
  assert.match(styles, /\.chat-log \{[\s\S]*gap: 28px;/u);
  assert.match(styles, /\.chat-log \.msg-agent:not\(\.msg-live\),\s*\.chat-scroll > \.msg-live \{[\s\S]*background: var\(--dialog-bubble-agent\);/u);
  assert.doesNotMatch(styles, /html\[data-view="chat"\] \.chat-log \.msg-agent:not\(\.msg-live\)/u);
  assert.match(styles, /\.msg-user-bubble \{[\s\S]*max-width: 560px;/u);
  assert.match(styles, /--dialog-stream-tabs-height: 44px;/u);
  assert.match(styles, /\.stream-tabs \{[\s\S]*position: relative;[\s\S]*z-index: 50;/u);
  assert.match(styles, /\.composer-quick-messages \{[\s\S]*flex-wrap: wrap;/u);
  assert.match(styles, /\.composer-quick-message \{[\s\S]*border-radius: 999px;/u);
  assert.match(styles, /\.stream-tabs-track \.stream-tab \{[\s\S]*align-items: center;/u);
  assert.match(styles, /\.activity-stream-list :is\(\.stream-tab-card\) \{[\s\S]*align-items: center;[\s\S]*width: 100%;/u);
  assert.doesNotMatch(styles, /\.activity-stream-list \.stream-tab,[\s\S]*?align-items: center;/u);
  assert.match(styles, /\.activity-stream-list \.provider-dot,[\s\S]*\.activity-stream-list \.task-time \{[\s\S]*align-self: center;/u);
  assert.match(styles, /\.provider-dot\[data-state="idle"\] \{[\s\S]*background: var\(--dialog-agent-color\);[\s\S]*opacity: 0\.8;/u);
  assert.match(styles, /\.provider-dot\[data-state="failed"\] \{[\s\S]*0 0 0 2px var\(--dialog-chrome\)/u);
  assert.match(styles, /\.stream-tabs-track \.stream-tab\[data-current\] \{[\s\S]*border: 0 !important;[\s\S]*box-shadow: inset 0 -2px 0 var\(--dialog-accent\) !important;/u);
  assert.match(styles, /\.stream-tabs-controls \.stream-tab-utility \{[\s\S]*flex: 0 0 26px !important;[\s\S]*width: 26px !important;/u);
  assert.match(styles, /\.msg-body pre code,[\s\S]*\.msg-reasoning pre code \*,?[\s\S]*\{[\s\S]*background: transparent !important;/u);
  assert.match(styles, /\.chat-scroll > \.msg-live \{[\s\S]*margin-top: 28px;[\s\S]*width: min\(var\(--dialog-column-width\), calc\(100% - 32px\)\);/u);
  assert.match(styles, /\.chat-stop-bottom \{[\s\S]*background: color-mix\(in srgb, var\(--dialog-danger\) 10%, transparent\);[\s\S]*width: 30px;/u);
  assert.doesNotMatch(styles, /(?<!track )\.stream-tab-card \{/u);
  // Полоса вкладок ничего не добавляет к признаку статуса: и рамка, и кольцо
  // оказались лишними. Сигнал рисует общий эффект, тот же, что в строке правой
  // панели, поэтому здесь не должно быть ни собственной анимации, ни рамки.
  assert.doesNotMatch(styles, /stream-tab-ring-sweep/u);
  assert.doesNotMatch(styles, /border: 1px solid var\(--accent-line\) !important/u);
  assert.match(styles, /\.composer \{[\s\S]*width: min\(var\(--dialog-column-width\), calc\(100% - 48px\)\);/u);
});

test("quick replies settings keep scope entry points and a two-row action pattern", async () => {
  const index = await readFile(new URL("index.html", assets), "utf8");
  const styles = await readFile(new URL("styles.css", assets), "utf8");
  assert.match(index, /Глобальные prompt-шаблоны[\s\S]*data-settings-global-quick-messages-count[\s\S]*data-settings-global-quick-messages[\s\S]*data-quick-message-rows[\s\S]*Добавить шаблон/u);
  assert.match(index, /Prompt-шаблоны Workspace[\s\S]*data-workspace-card-quick-messages-count[\s\S]*data-workspace-card-quick-messages/u);
  assert.match(index, /Prompt-шаблоны потока[\s\S]*data-dialog-stream-quick-messages-count[\s\S]*data-dialog-stream-quick-messages/u);
  assert.doesNotMatch(index, /data-dialog-global-quick-messages/u);
  assert.match(styles, /\.quick-messages-settings-row \{[\s\S]*display: grid;[\s\S]*gap: 0\.35rem;/u);
  assert.doesNotMatch(styles, /\.dialog-quick-messages-row/u);
});

test("Orange defines the reference dialog palette only as theme tokens", async () => {
  const orange = await readFile(new URL("themes/orange/theme.css", assets), "utf8");
  const expected = new Map([
    ["canvas", "#f7f4ee"],
    ["chrome", "#efeae1"],
    ["raised", "#fdfbf7"],
    ["sunken", "#f2ece2"],
    ["bubble-user", "#efe7db"],
    ["code-bg", "#eee7dc"],
    ["hairline", "#e3dace"],
    ["text", "#2b2723"],
    ["text-2", "#56504a"],
    ["text-3", "#8a8075"],
    ["text-4", "#a49a8d"],
    ["accent", "#c2643a"],
    ["accent-press", "#a8542a"],
    ["danger", "#b8493c"],
    ["agent-1", "#c2643a"],
    ["agent-2", "#8a5fa8"],
    ["agent-3", "#3f8a7d"],
    ["neutral-bar", "#b9ac97"],
  ]);
  for (const [name, value] of expected) {
    assert.ok(orange.includes(`--dialog-${name}: ${value};`));
  }
});

test("dialog interactions expose overflow, message actions and anchored context", async () => {
  const app = await readFile(new URL("app.js", assets), "utf8");
  assert.match(app, /data-stream-tabs-overflow-count/u);
  assert.match(app, /class: "stream-tabs-overflow-menu",[\s\S]*hidden: true,/u);
  assert.match(app, /class: "stream-tabs-overflow",[\s\S]*hidden: true,/u);
  assert.match(app, /class: "stream-overflow-item",[\s\S]*hidden: true,/u);
  assert.match(app, /scheduleStreamTabsOverflow\(\)/u);
  assert.match(app, /label: "Редактировать"/u);
  assert.match(app, /label: "Повторить"/u);
  assert.match(app, /contextUsageModal\.show\(\)/u);
  assert.doesNotMatch(app, /contextUsageModal\.showModal\(\)/u);
  assert.match(app, /const major = category\.tokens != null && share >= 2;/u);
  assert.match(app, /class: "msg-technical"/u);
  assert.match(app, /class: "msg-user-bubble"/u);
  assert.match(app, /createPhosphorIcon\(document, "caret-right", "activity-disclosure-icon"\)/u);
  assert.match(app, /streamHeaderModel\.textContent = shortModelLabel\(model\)/u);
});
