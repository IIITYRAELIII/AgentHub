"use strict";

const vscode = require("vscode");

const { AgentHubBridge } = require("./agent-hub-bridge.js");
const { renderWorkLog } = require("./render.js");
const { sharedWebviewHtml } = require("./shared-webview.js");
const { baseCss, panelCss, sidebarHtml, webviewHtml } = require("./webview.js");

const VIEW_ID = "agentHub.view";
const CSS_PATH = ["Utilities", "AgentHub", "work-log.css"];
const MINI_APP_CSS_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "styles.css"];
const PULSAR_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "pulsar-beams.png"];
const BLACKHOLE_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "blackhole-blue.png"];
const TAIGA_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "rainforest-night.png"];
const MAGMA_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "magma-crust.png"];
const METROPOLIS_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "metropolis-night.png"];
const STORM_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "storm-rain.png"];
const MEADOW_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "meadow-sun.png"];
const ORBIT_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "orbit-earth.png"];
const NEBULA_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "nebula-veil.png"];
const GOTHIC_IMAGE_PATH = ["Utilities", "AgentHub", "assets", "mini-app", "gothic-concrete.png"];
const THEME_KEY = "agentHub.theme";
const THEMES = new Set([
  "orbit", "nebula", "pulsar", "gothic", "blackhole", "taiga", "metropolis",
  "magma", "storm", "meadow",
]);

/* Заголовок панели — путь журнала в привычной для Windows форме: `.\WORK_LOG`. */
function panelTitle(journalUri) {
  const relative = vscode.workspace.asRelativePath(journalUri, false);
  return `.\\${relative.replaceAll("/", "\\").replace(/\.md$/iu, "")}`;
}

function relativeSegments(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(candidate);
      if (stat.type & vscode.FileType.File) return candidate;
    } catch {
      // The next workspace folder may contain the configured file.
    }
  }
  return candidates[0] ?? null;
}

async function readUtf8(uri) {
  if (!uri) return "";
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

class WorkLogViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.panel = null;
    this.timer = null;
    this.lastPayload = "";
    this.bridge = null;
    this.bridgeJournal = "";
    this.sharedPanel = false;
    this.theme = THEMES.has(context.globalState.get(THEME_KEY))
      ? context.globalState.get(THEME_KEY)
      : "orbit";
  }

  /* Тема принадлежит расширению, поэтому боковая панель и вкладка журнала
     всегда показывают одно оформление — как Mini App в Telegram. */
  async setTheme(value, from) {
    if (!THEMES.has(value) || value === this.theme) return;
    this.theme = value;
    await this.context.globalState.update(THEME_KEY, value);
    if (from !== "sidebar") await this.view?.webview.postMessage({ type: "theme", theme: value });
    if (from !== "panel") await this.panel?.webview.postMessage({ type: "theme", theme: value });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = sidebarHtml(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      if (message?.type === "open") void this.openPanel();
    }, null, this.context.subscriptions);
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.openPanel();
    }, null, this.context.subscriptions);
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
    }, null, this.context.subscriptions);
    void this.openPanel();
  }

  async openPanel() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      this.scheduleRefresh(0, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentHub.editor",
      ".\\WORK_LOG",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // растровые фоны тем лежат в workspace — иначе webview их не отдаст
        localResourceRoots: this.workspaceFolders().map((folder) => folder.uri),
        retainContextWhenHidden: true,
      },
    );
    this.panel = panel;
    panel.title = "Agent Hub";
    try {
      panel.webview.html = (await sharedWebviewHtml(panel.webview)).html;
      this.sharedPanel = true;
    } catch (error) {
      panel.webview.html = webviewHtml(panel.webview, this.theme);
      this.sharedPanel = false;
      void vscode.window.showErrorMessage(`Agent Hub: ${error.message}`);
    }
    panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "agenthub:control") void this.handleControlMessage(message);
      if (message?.type === "agenthub:http") void this.handleHttpMessage(message);
      if (message?.type === "open-link") void this.openLink(message.href);
      if (message?.type === "theme") void this.setTheme(message.theme, "panel");
    }, null, this.context.subscriptions);
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
      this.sharedPanel = false;
      this.lastPayload = "";
    }, null, this.context.subscriptions);
    this.scheduleRefresh(0, true);
  }

  async currentBridge() {
    const journalUri = await firstExisting(this.configuredJournalUris());
    if (!journalUri) throw new Error("Откройте workspace с WORK_LOG.md");
    const key = journalUri.fsPath;
    if (!this.bridge || this.bridgeJournal !== key) {
      this.bridge?.close();
      this.bridge = new AgentHubBridge({ journalFile: key });
      this.bridgeJournal = key;
    }
    return this.bridge;
  }

  async handleControlMessage(message) {
    const id = String(message?.id ?? "");
    try {
      const bridge = await this.currentBridge();
      const result = await bridge.control(String(message.action ?? ""), message.params ?? {});
      await this.panel?.webview.postMessage({
        type: "agenthub:control-result",
        id,
        ok: true,
        result,
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: "agenthub:control-result",
        id,
        ok: false,
        error: String(error?.message ?? error),
      });
    }
  }

  async handleHttpMessage(message) {
    const id = String(message?.id ?? "");
    try {
      const bridge = await this.currentBridge();
      const result = await bridge.http(message);
      await this.panel?.webview.postMessage({
        type: "agenthub:http-result",
        id,
        ...result,
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: "agenthub:http-result",
        id,
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: `${JSON.stringify({ error: String(error?.message ?? error) })}\n`,
      });
    }
  }

  workspaceFolders() {
    return vscode.workspace.workspaceFolders ?? [];
  }

  configuredJournalUris() {
    const fileName = vscode.workspace
      .getConfiguration("agentHub")
      .get("fileName", "WORK_LOG.md");
    const segments = relativeSegments(fileName);
    return this.workspaceFolders().map((folder) => vscode.Uri.joinPath(folder.uri, ...segments));
  }

  cssUris(segments) {
    return this.workspaceFolders().map((folder) => vscode.Uri.joinPath(folder.uri, ...segments));
  }

  /* Mini App берёт растровые фоны по HTTP, у панели сервера нет — подменяем
     адреса на webview-URI тех же файлов из workspace. */
  async themeAssetCss() {
    const [pulsarImage, blackHoleImage, taigaImage, magmaImage, metropolisImage, stormImage,
      meadowImage, orbitImage, nebulaImage, gothicImage] = await Promise.all([
      firstExisting(this.cssUris(PULSAR_IMAGE_PATH)),
      firstExisting(this.cssUris(BLACKHOLE_IMAGE_PATH)),
      firstExisting(this.cssUris(TAIGA_IMAGE_PATH)),
      firstExisting(this.cssUris(MAGMA_IMAGE_PATH)),
      firstExisting(this.cssUris(METROPOLIS_IMAGE_PATH)),
      firstExisting(this.cssUris(STORM_IMAGE_PATH)),
      firstExisting(this.cssUris(MEADOW_IMAGE_PATH)),
      firstExisting(this.cssUris(ORBIT_IMAGE_PATH)),
      firstExisting(this.cssUris(NEBULA_IMAGE_PATH)),
      firstExisting(this.cssUris(GOTHIC_IMAGE_PATH)),
    ]);
    const webview = this.panel?.webview;
    if (!webview) return "";
    const rules = [];
    if (pulsarImage) {
      rules.push(`html[data-theme="pulsar"] { --pulsar-image: url("${webview.asWebviewUri(pulsarImage)}"); }`);
    }
    if (blackHoleImage) {
      rules.push(`html[data-theme="blackhole"] { --bh-image: url("${webview.asWebviewUri(blackHoleImage)}"); }`);
    }
    if (taigaImage) {
      rules.push(`html[data-theme="taiga"] { --forest-image: url("${webview.asWebviewUri(taigaImage)}"); }`);
    }
    if (magmaImage) {
      rules.push(`html[data-theme="magma"] { --magma-image: url("${webview.asWebviewUri(magmaImage)}"); }`);
    }
    if (metropolisImage) {
      rules.push(`html[data-theme="metropolis"] { --metropolis-image: url("${webview.asWebviewUri(metropolisImage)}"); }`);
    }
    if (stormImage) {
      rules.push(`html[data-theme="storm"] { --storm-image: url("${webview.asWebviewUri(stormImage)}"); }`);
    }
    return rules.join("\n");
  }

  async journalCss() {
    const [workLogUri, miniAppUri] = await Promise.all([
      firstExisting(this.cssUris(CSS_PATH)),
      firstExisting(this.cssUris(MINI_APP_CSS_PATH)),
    ]);
    const [workLogCss, miniAppCss, assetCss] = await Promise.all([
      readUtf8(workLogUri).catch(() => ""),
      readUtf8(miniAppUri).catch(() => ""),
      this.themeAssetCss().catch(() => ""),
    ]);
    return [workLogCss, miniAppCss, panelCss(), assetCss].filter(Boolean).join("\n");
  }

  scheduleRefresh(delay = 100, force = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh(force);
    }, delay);
  }

  async refresh(force = false) {
    if (!this.panel) return;
    if (this.sharedPanel) {
      await this.panel.webview.postMessage({ type: "agenthub:journal-changed", force });
      return;
    }
    try {
      const journalUri = await firstExisting(this.configuredJournalUris());
      if (!journalUri) {
        await this.render(
          '<div class="work-log-empty">Откройте workspace с WORK_LOG.md.</div>',
          await this.journalCss(),
          force,
        );
        return;
      }
      const [source, css] = await Promise.all([
        readUtf8(journalUri),
        this.journalCss(),
      ]);
      const title = panelTitle(journalUri);
      if (this.view) this.view.description = vscode.workspace.asRelativePath(journalUri, false);
      if (this.panel) this.panel.title = title;
      await this.render(renderWorkLog(source), css, force, title);
    } catch (error) {
      await this.render(
        `<div class="work-log-empty">Не удалось прочитать журнал: ${
          String(error?.message ?? error).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        }</div>`,
        "",
        true,
      );
    }
  }

  async render(html, css, force, title = ".\\WORK_LOG") {
    const payload = JSON.stringify({ html, css, title });
    if (!force && payload === this.lastPayload) return;
    this.lastPayload = payload;
    await this.panel?.webview.postMessage({ type: "render", html, css, title });
  }

  async openLink(rawHref) {
    const href = String(rawHref ?? "").trim();
    if (!href || href.startsWith("#")) return;
    if (/^(?:https?|vscode):/iu.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const segments = relativeSegments(decodeURIComponent(href));
    const target = await firstExisting(
      this.workspaceFolders().map((folder) => vscode.Uri.joinPath(folder.uri, ...segments)),
    );
    if (target) await vscode.commands.executeCommand("vscode.open", target);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.bridge?.close();
  }
}

function activate(context) {
  const provider = new WorkLogViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("agentHub.open", () => provider.openPanel()),
    vscode.commands.registerCommand("agentHub.refresh", () => provider.scheduleRefresh(0, true)),
  );

  const refresh = () => provider.scheduleRefresh();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const journal = vscode.workspace
      .getConfiguration("agentHub")
      .get("fileName", "WORK_LOG.md");
    for (const pattern of [journal, CSS_PATH.join("/"), MINI_APP_CSS_PATH.join("/")]) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, pattern),
      );
      watcher.onDidChange(refresh, null, context.subscriptions);
      watcher.onDidCreate(refresh, null, context.subscriptions);
      watcher.onDidDelete(refresh, null, context.subscriptions);
      context.subscriptions.push(watcher);
    }
  }
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.path.endsWith("/WORK_LOG.md")) refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentHub.fileName")) provider.scheduleRefresh(0, true);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
