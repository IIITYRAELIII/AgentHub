"use strict";

const vscode = require("vscode");
const path = require("node:path");

const {
  AgentHubBridge,
  webviewHttpMessages,
} = require("./agent-hub-bridge.js");
const { sharedWebviewHtml } = require("./shared-webview.js");
const { sidebarHtml } = require("./webview.js");

const VIEW_ID = "agentHub.view";
const THEME_KEY = "agentHub.theme";

function relativeSegments(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".");
}

function editorFileTarget(value) {
  const decoded = decodeURIComponent(String(value ?? "").trim());
  const positioned = decoded.match(/^(?<file>.+):(?<line>[1-9][0-9]*):(?<column>[1-9][0-9]*)$/u)
    ?? decoded.match(/^(?<file>.+):(?<line>[1-9][0-9]*)$/u);
  return {
    file: String(positioned?.groups?.file ?? decoded),
    line: Number(positioned?.groups?.line) || 0,
    column: Number(positioned?.groups?.column) || 0,
  };
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
  return null;
}

function literalGlob(value) {
  return String(value ?? "").replace(/[?*\[\]{}]/gu, (character) => `[${character}]`);
}

async function resolveAbsoluteWorkspaceFile(file, workspaceFolders) {
  const contained = workspaceFolders.flatMap((folder) => {
    const root = path.resolve(folder.uri.fsPath);
    const candidate = path.resolve(file);
    const relative = path.relative(root, candidate);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? [{ folder, root, candidate, relative }]
      : [];
  });
  const exact = await firstExisting(contained.map(({ candidate }) => vscode.Uri.file(candidate)));
  if (exact) return exact;
  const discovered = [];
  for (const { folder, root, relative } of contained) {
    const suffix = relativeSegments(relative).join("/").toLowerCase();
    const basename = relativeSegments(relative).at(-1);
    if (!suffix || !basename) continue;
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, `**/${literalGlob(basename)}`),
      undefined,
      50,
    );
    for (const match of matches) {
      const matchedRelative = path.relative(root, path.resolve(match.fsPath));
      if (!matchedRelative || matchedRelative.startsWith("..") || path.isAbsolute(matchedRelative)) continue;
      const normalized = relativeSegments(matchedRelative).join("/").toLowerCase();
      if (normalized === suffix || normalized.endsWith(`/${suffix}`)) discovered.push(match);
    }
  }
  const unique = [...new Map(discovered.map((uri) => [path.resolve(uri.fsPath).toLowerCase(), uri])).values()];
  return unique.length === 1 ? unique[0] : null;
}

class WorkLogViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.panel = null;
    this.timer = null;
    this.bridge = null;
    this.unsubscribeJournal = null;
    this.unsubscribeRuntime = null;
    this.sharedPanel = false;
    this.panelRuntimeRoot = null;
    this.themes = new Set(["orbit"]);
    this.theme = String(context.globalState.get(THEME_KEY) ?? "orbit");
  }

  /* Тема принадлежит расширению, поэтому боковая панель и вкладка журнала
     всегда показывают одно оформление — как Mini App в Telegram. */
  async setTheme(value, from) {
    if (!this.themes.has(value) || value === this.theme) return;
    this.theme = value;
    await this.context.globalState.update(THEME_KEY, value);
    if (from !== "sidebar") await this.view?.webview.postMessage({ type: "theme", theme: value });
    if (from !== "panel") await this.panel?.webview.postMessage({ type: "theme", theme: value });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    const markUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "agent-hub-mark.png"),
    );
    view.webview.html = sidebarHtml(view.webview, markUri);
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
      await this.refreshPanelShellIfReleaseChanged();
      this.scheduleRefresh(0, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentHub.editor",
      "Agent Hub",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [
          this.context.extensionUri,
        ],
        retainContextWhenHidden: true,
      },
    );
    this.panel = panel;
    panel.title = "Agent Hub";
    try {
      await this.renderPanelShell(panel);
      this.sharedPanel = true;
    } catch (error) {
      panel.webview.html = `<!doctype html><html lang="ru"><head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
        <style>body{padding:24px;color:#ddd;background:#10161b;font:14px system-ui}</style>
        </head><body>Ресурсы Agent Hub повреждены. Переустановите расширение.</body></html>`;
      this.sharedPanel = "unavailable";
      void vscode.window.showErrorMessage(`Agent Hub: ${error.message}`);
    }
    panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "agenthub:control") void this.handleControlMessage(message);
      if (message?.type === "agenthub:http") void this.handleHttpMessage(message);
      if (message?.type === "agenthub:runtime-changed") {
        void this.refreshPanelShellIfReleaseChanged().catch(() => {});
      }
      if (message?.type === "open-link") void this.openLink(message.href);
      if (message?.type === "theme") void this.setTheme(message.theme, "panel");
    }, null, this.context.subscriptions);
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
      this.sharedPanel = false;
      this.panelRuntimeRoot = null;
    }, null, this.context.subscriptions);
    this.scheduleRefresh(0, true);
  }

  async currentBridge() {
    if (!this.bridge) {
      this.bridge = new AgentHubBridge();
      this.unsubscribeJournal = await this.bridge.subscribeJournal(
        () => this.scheduleRefresh(0),
      );
      this.unsubscribeRuntime = this.bridge.subscribeRuntime(
        () => this.refreshPanelShellIfReleaseChanged(),
      );
    }
    return this.bridge;
  }

  async renderPanelShell(panel = this.panel, runtimeRoot = null) {
    if (!panel) return;
    const bridge = await this.currentBridge();
    const activeRuntimeRoot = runtimeRoot ?? await bridge.runtimeReleaseRoot();
    const runtimeUri = vscode.Uri.file(activeRuntimeRoot);
    /* В webview разрешены только неизменяемый активный release и bootstrap
       самого расширения. Workspace сюда намеренно не попадает. */
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        runtimeUri,
        vscode.Uri.file(bridge.attachmentDirectory()),
      ],
    };
    const shell = await sharedWebviewHtml(panel.webview, {
      runtimeUri,
      extensionUri: this.context.extensionUri,
    });
    this.themes = new Set(shell.themeIds);
    if (!this.themes.has(this.theme)) this.theme = "orbit";
    panel.webview.html = shell.html;
    this.panelRuntimeRoot = activeRuntimeRoot;
  }

  async refreshPanelShellIfReleaseChanged() {
    if (!this.panel || this.sharedPanel === "unavailable") return false;
    const bridge = await this.currentBridge();
    const runtimeRoot = await bridge.runtimeReleaseRoot();
    if (runtimeRoot === this.panelRuntimeRoot) return false;
    await this.renderPanelShell(this.panel, runtimeRoot);
    return true;
  }

  async handleControlMessage(message) {
    const id = String(message?.id ?? "");
    try {
      const bridge = await this.currentBridge();
      const action = String(message.action ?? "");
      if (action === "open-attachment") {
        const target = await bridge.attachmentPath(message.params?.id);
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target));
        await this.panel?.webview.postMessage({
          type: "agenthub:control-result",
          id,
          ok: true,
          result: { opened: true },
        });
        return;
      }
      const result = await bridge.control(action, message.params ?? {});
      await this.decorateAttachmentUrls(result, bridge);
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

  async decorateAttachmentUrls(value, bridge) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) await this.decorateAttachmentUrls(item, bridge);
      return;
    }
    if (Array.isArray(value.attachments)) {
      value.attachments = await Promise.all(value.attachments.map(async (attachment) => {
        const item = { ...attachment };
        try {
          const target = await bridge.attachmentPath(item.id);
          item.url = this.panel?.webview.asWebviewUri(vscode.Uri.file(target)).toString() ?? "";
        } catch {
          item.missing = true;
        }
        return item;
      }));
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key !== "attachments") await this.decorateAttachmentUrls(nested, bridge);
    }
  }

  async handleHttpMessage(message) {
    const id = String(message?.id ?? "");
    try {
      const bridge = await this.currentBridge();
      const result = await bridge.http(message);
      for (const part of webviewHttpMessages(id, result)) {
        await this.panel?.webview.postMessage(part);
      }
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

  scheduleRefresh(delay = 100, force = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh(force);
    }, delay);
  }

  async refresh(force = false) {
    if (!this.panel) return;
    if (this.sharedPanel === "unavailable") return;
    try {
      await this.currentBridge();
      await this.refreshPanelShellIfReleaseChanged();
    } catch {
      // Обычное обновление журнала не превращаем в ошибку панели.
    }
    await this.panel.webview.postMessage({ type: "agenthub:journal-changed", force });
  }

  async openLink(rawHref) {
    const href = String(rawHref ?? "").trim();
    if (!href || href.startsWith("#")) return;
    if (/^(?:https?|vscode):/iu.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const fileTarget = editorFileTarget(href);
    const absolute = /^[A-Za-z]:[\\/]/u.test(fileTarget.file);
    const target = absolute
      ? await resolveAbsoluteWorkspaceFile(fileTarget.file, this.workspaceFolders())
      : await firstExisting(
        this.workspaceFolders().map((folder) => vscode.Uri.joinPath(
          folder.uri,
          ...relativeSegments(fileTarget.file),
        )),
      );
    if (target) {
      const options = fileTarget.line ? {
        selection: new vscode.Range(
          Math.max(0, fileTarget.line - 1),
          Math.max(0, fileTarget.column - 1),
          Math.max(0, fileTarget.line - 1),
          Math.max(0, fileTarget.column - 1),
        ),
      } : undefined;
      await vscode.commands.executeCommand("vscode.open", target, options);
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribeJournal?.();
    this.unsubscribeRuntime?.();
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

}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  editorFileTarget,
  firstExisting,
  resolveAbsoluteWorkspaceFile,
};
