import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { createWorkspaceCatalogMutationOwner } from "../../src/application/sqlite-mutation-owner.mjs";
import { WorkspaceCatalogService } from "../../src/application/workspace-catalog-service.mjs";
import { createApplicationCommandService } from "../../src/application/application-command-service.mjs";
import { createDesktopApplicationRouter } from "../../src/interfaces/desktop/desktop-application-router.mjs";
import { createWorkspaceActions } from "../../src/composition/desktop-command-wiring-composition.mjs";
import { snapshot as initialSnapshot } from "./composer-production.fixture.mjs";

export async function catalogFixture({ initialize, baseSnapshot = initialSnapshot() } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(),"agent-hub-folder-dom-"));
  const raw = new WorkspaceCatalogStore({ databaseFile: path.join(root,"journal.sqlite") });
  await raw.load();
  if (initialize) initialize(raw);
  else {
  raw.createWorkspace({ id: "workspace-1", name: "Workspace", settings: {} });
  raw.createStream({ id: "stream-a", workspaceId: "workspace-1", name: "Stream A" });
  raw.createStream({ id: "stream-b", workspaceId: "workspace-1", name: "Stream B" });
  raw.workspaceFolderCommand({ requestId: "seed-empty", action: "create", payload: { name: "Пустая" } });
  raw.createWorkspace({ id: "workspace-b", name: "Вложенный", settings: { catalogFolder: "Клиенты" } });
  raw.createStream({ id: "stream-member", workspaceId: "workspace-b", name: "Member" });
  }
  const service = new WorkspaceCatalogService({ store: createWorkspaceCatalogMutationOwner(raw) });
  const base = baseSnapshot;
  const snapshot = () => {
    const workspaces = raw.hierarchy();
    return { ...base, version: `folders-${raw.snapshotRevision}`, workspaces, workspaceFolders: raw.workspaceFolderCatalog(),
      tasks: base.tasks.map(task => ({ ...task, workspaceSettings: raw.workspace(task.workspaceId)?.settings ?? {} })),
    };
  };
  const faults = { gate: null, lose: false, readFailure: false, previewGate: null, previewFailure: false };
  const jobs = new Set();
  const actions = createWorkspaceActions({ workspaceCatalogService: service,
    workspaceMutation: async (operation,{ resultKey } = {}) => {
      if (faults.gate) await faults.gate.promise;
      const result = await operation(); return { ...snapshot(), ...(resultKey ? { [resultKey]: result } : {}) };
    },
  });
  const commands = createApplicationCommandService({ handlers: new Proxy(actions,{ get: (target,key) => target[key] ?? (() => snapshot()) }) });
  const router = createDesktopApplicationRouter({ commands,
    handlers: new Proxy({ snapshot },{ get: (target,key) => target[key] ?? (() => snapshot()) }),
    receiptFile: path.join(root,"control-receipts.json"),
  });
  const calls = [];
  const control = async message => {
    calls.push(structuredClone(message));
    if (message.action === "workspace-folder-preview" && faults.previewFailure) { faults.previewFailure = false; throw new Error("fixture preview unavailable"); }
    if (message.action === "workspace-folder-preview" && faults.previewGate) await faults.previewGate.promise;
    if (message.action === "workspace-folder-result" && faults.readFailure) { faults.readFailure = false; throw new Error("fixture readback unavailable"); }
    const operation = router.handleDesktopControl({ action: message.action, params: message.params ?? {},
      context: { source: message.transport === "http" ? "local-mini-app" : "local-vscode-webview",
        clientId: "folder-fixture", commandId: message.id ?? message.commandId } });
    jobs.add(operation); void operation.finally(() => jobs.delete(operation)).catch(() => {});
    if (faults.lose && ["mutate-workspace-folder","move-workspace-to-folder"].includes(message.action)) {
      faults.lose = false; throw new Error("fixture lost admitted response");
    }
    return operation;
  };
  const close = async () => {
    faults.gate?.release(); faults.previewGate?.release(); await Promise.allSettled([...jobs]);
    raw.close(); await rm(root,{ recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  return { raw, snapshot, control, calls, close, faults, jobs };
}
