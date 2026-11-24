import { randomUUID } from "node:crypto";
import { commandFingerprint } from "../../domain/command-fingerprint.mjs";

export function workspaceFolderName(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 80);
}
const keyOf = name => workspaceFolderName(name).toLocaleLowerCase("ru");
const settingsOf = row => {
  try { const value = JSON.parse(row.settings_json); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};
const folderOf = row => row ? { id: row.id, name: row.name, revision: row.revision } : null;
const FOLDER_SQL = "json_extract(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END,'$.catalogFolder')";

export class WorkspaceFolderConflict extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
function refuse(code, message, details) { throw new WorkspaceFolderConflict(code, message, details); }

// Runs only inside WorkspaceCatalogStore's existing schema transaction. No new
// connection, queue or startup recovery owner is created here.
export function configureWorkspaceFolders(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS hub_workspace_folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0), deleted_at_ms INTEGER
    ) WITHOUT ROWID;
    CREATE UNIQUE INDEX IF NOT EXISTS hub_workspace_folder_live_name
      ON hub_workspace_folders(name_key) WHERE deleted_at_ms IS NULL;
    CREATE TABLE IF NOT EXISTS hub_workspace_folder_retired_names (
      name_key TEXT PRIMARY KEY
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS hub_workspace_folder_operations (
      request_id TEXT PRIMARY KEY, arguments_hash TEXT NOT NULL, receipt_json TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS hub_workspace_folder_members_idx ON hub_workspaces(${FOLDER_SQL});
  `);
  if (!database.prepare("SELECT value FROM hub_workspace_catalog_meta WHERE key='workspace_folders_v1'").get()) {
    const find = database.prepare("SELECT name FROM hub_workspace_folders WHERE name_key=? AND deleted_at_ms IS NULL");
    const insert = database.prepare("INSERT INTO hub_workspace_folders(id,name,name_key,revision) VALUES(?,?,?,1)");
    for (const row of database.prepare("SELECT id,settings_json FROM hub_workspaces ORDER BY id").all()) {
      const settings = settingsOf(row);
      const name = workspaceFolderName(settings.catalogFolder);
      if (!name) continue;
      let canonical = find.get(keyOf(name))?.name;
      if (!canonical) { insert.run(randomUUID(), name, keyOf(name)); canonical = name; }
      if (settings.catalogFolder !== canonical) {
        settings.catalogFolder = canonical;
        database.prepare("UPDATE hub_workspaces SET settings_json=? WHERE id=?").run(JSON.stringify(settings), row.id);
      }
    }
    database.prepare("INSERT INTO hub_workspace_catalog_meta(key,value) VALUES('workspace_folders_v1','completed')").run();
  }
  const name = side => `json_extract(CASE WHEN json_valid(${side}.settings_json) THEN ${side}.settings_json ELSE '{}' END,'$.catalogFolder')`;
  for (const event of ["INSERT", "UPDATE OF settings_json"]) {
    const suffix = event.startsWith("INSERT") ? "insert" : "update";
    database.exec(`CREATE TRIGGER IF NOT EXISTS hub_workspace_folder_valid_${suffix}
      BEFORE ${event} ON hub_workspaces
      WHEN COALESCE(${name("NEW")},'')<>'' AND NOT EXISTS(
        SELECT 1 FROM hub_workspace_folders WHERE name=${name("NEW")} AND deleted_at_ms IS NULL)
      BEGIN SELECT RAISE(ABORT,'Workspace folder identity is absent; refresh the catalog'); END;`);
  }
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS hub_workspace_folder_member_insert AFTER INSERT ON hub_workspaces
    BEGIN UPDATE hub_workspace_folders SET revision=revision+1 WHERE name=${name("NEW")} AND deleted_at_ms IS NULL; END;
    CREATE TRIGGER IF NOT EXISTS hub_workspace_folder_member_delete AFTER DELETE ON hub_workspaces
    BEGIN UPDATE hub_workspace_folders SET revision=revision+1 WHERE name=${name("OLD")} AND deleted_at_ms IS NULL; END;
    CREATE TRIGGER IF NOT EXISTS hub_workspace_folder_member_update AFTER UPDATE OF settings_json,name ON hub_workspaces
    WHEN ${name("OLD")} IS NOT ${name("NEW")} OR OLD.name IS NOT NEW.name
    BEGIN UPDATE hub_workspace_folders SET revision=revision+1
      WHERE (name=${name("OLD")} OR name=${name("NEW")}) AND deleted_at_ms IS NULL; END;
  `);
}

// A collaborator of the catalog transaction, never a standalone persistence
// service. Membership remains in settings.catalogFolder, its original owner.
export class WorkspaceFolderCatalog {
  constructor({ database, transaction, now }) { this.db = database; this.transaction = transaction; this.now = now; }
  row(id) { return this.db.prepare("SELECT * FROM hub_workspace_folders WHERE id=? AND deleted_at_ms IS NULL").get(id); }
  named(name) { return this.db.prepare("SELECT * FROM hub_workspace_folders WHERE name_key=? AND deleted_at_ms IS NULL").get(keyOf(name)); }
  catalog() {
    const folders = this.db.prepare("SELECT * FROM hub_workspace_folders WHERE deleted_at_ms IS NULL").all()
      .map(folderOf).sort((a,b) => a.name.localeCompare(b.name,"ru") || a.id.localeCompare(b.id));
    return { version: 1, revision: commandFingerprint(folders), folders };
  }
  members(name) {
    return this.db.prepare(`SELECT id,name FROM hub_workspaces WHERE ${FOLDER_SQL}=?`).all(name)
      .map(row=>({ id: row.id,name: row.name }))
      .sort((a,b)=>a.name.localeCompare(b.name,"ru") || a.id.localeCompare(b.id));
  }
  rows(name) { return this.db.prepare(`SELECT id,settings_json FROM hub_workspaces WHERE ${FOLDER_SQL}=?`).all(name); }
  preview(id) {
    return this.transaction(() => {
      const folder = folderOf(this.row(id));
      if (!folder) return { folderId: id, absent: true };
      const members = this.members(folder.name);
      const content = { folder, members, childFolders: 0 };
      return { ...content, token: commandFingerprint(content) };
    });
  }
  requireFolder(id, revision) {
    if (typeof id !== "string" || !id || !Number.isSafeInteger(revision) || revision < 1) {
      refuse("FOLDER_IDENTITY_REQUIRED", "Для операции требуются точные identity/revision папки.");
    }
    const folder = this.row(id);
    if (!folder) refuse("FOLDER_ABSENT", "Папка изменилась или удалена.");
    if (revision !== folder.revision) refuse("FOLDER_STALE", "Папка изменилась или удалена.");
    return folder;
  }
  create(name, { importing = false } = {}) {
    if (typeof name !== "string") refuse("FOLDER_NAME_REQUIRED", "Введите имя папки.");
    const normalized = workspaceFolderName(name);
    if (!normalized) refuse("FOLDER_NAME_REQUIRED", "Введите имя папки.");
    const existing = this.named(normalized);
    if (existing) {
      if (importing) return folderOf(existing);
      refuse("FOLDER_NAME_EXISTS", "Папка с таким именем уже существует.");
    }
    if (importing && this.db.prepare("SELECT 1 FROM hub_workspace_folder_retired_names WHERE name_key=?").get(keyOf(normalized))) return null;
    const id = randomUUID();
    this.db.prepare("INSERT INTO hub_workspace_folders(id,name,name_key,revision) VALUES(?,?,?,1)").run(id,normalized,keyOf(normalized));
    return folderOf(this.row(id));
  }
  retireName(name) { this.db.prepare("INSERT OR IGNORE INTO hub_workspace_folder_retired_names(name_key) VALUES(?)").run(keyOf(name)); }
  // Legacy internal creation/import only. Public move never resolves by name.
  ensureWorkspaceCreation(name) {
    const existing = this.named(name);
    if (existing) return existing.name;
    const folder = this.create(name, { importing: true });
    if (!folder) refuse("FOLDER_ABSENT", "Папка изменилась или удалена.");
    return folder.name;
  }
  updateMembership(row, folderName) {
    const settings = settingsOf(row);
    if (folderName) settings.catalogFolder = folderName;
    else delete settings.catalogFolder;
    this.db.prepare("UPDATE hub_workspaces SET settings_json=?,updated_at_ms=? WHERE id=?")
      .run(JSON.stringify(settings),this.now(),row.id);
  }
  rename(folder, name) {
    const normalized = workspaceFolderName(name);
    if (!normalized) refuse("FOLDER_NAME_REQUIRED", "Введите имя папки.");
    const duplicate = this.named(normalized);
    if (duplicate && duplicate.id !== folder.id) refuse("FOLDER_NAME_EXISTS", "Папка с таким именем уже существует.");
    if (folder.name === normalized) return { folder: folderOf(folder), workspaceCount: 0 };
    const rows = this.rows(folder.name);
    this.retireName(folder.name);
    this.db.prepare("UPDATE hub_workspace_folders SET name=?,name_key=?,revision=revision+1 WHERE id=?")
      .run(normalized,keyOf(normalized),folder.id);
    for (const row of rows) this.updateMembership(row,normalized);
    return { folder: folderOf(this.row(folder.id)), workspaceCount: rows.length };
  }
  apply(action, payload) {
    if (action === "create") return { folder: this.create(payload.name) };
    if (action === "import") {
      if (!Array.isArray(payload.names) || payload.names.length > 100 || payload.names.some(x => typeof x !== "string")) {
        refuse("FOLDER_IMPORT_INVALID", "Некорректный список папок.");
      }
      for (const name of payload.names) if (workspaceFolderName(name)) this.create(name,{ importing: true });
      return this.catalog();
    }
    if (action === "rename") return this.rename(this.requireFolder(payload.folderId,payload.expectedRevision),payload.name);
    if (action === "remove") {
      const preview = this.preview(payload.folderId);
      if (preview.absent) refuse("FOLDER_ABSENT", "Папка уже удалена в другом окне.");
      if (payload.previewToken !== preview.token) refuse("FOLDER_STALE", "Состав папки изменился.", { preview });
      const rows = this.rows(preview.folder.name);
      for (const row of rows) this.updateMembership(row,"");
      this.retireName(preview.folder.name);
      this.db.prepare("UPDATE hub_workspace_folders SET deleted_at_ms=?,revision=revision+1 WHERE id=?").run(this.now(),preview.folder.id);
      return { ...preview, deleted: true };
    }
    if (action === "move") {
      if (typeof payload.workspaceId !== "string" || !payload.workspaceId) refuse("WORKSPACE_UNAVAILABLE", "Workspace недоступен для перемещения.");
      const row = this.db.prepare("SELECT id,name,kind,settings_json FROM hub_workspaces WHERE id=? AND archived_at_ms IS NULL").get(payload.workspaceId);
      if (!row || row.kind !== "user") refuse("WORKSPACE_UNAVAILABLE", "Workspace недоступен для перемещения.");
      const current = this.named(settingsOf(row).catalogFolder ?? "");
      if (!Object.hasOwn(payload,"sourceFolderId") || (current?.id ?? null) !== payload.sourceFolderId) {
        refuse("WORKSPACE_FOLDER_STALE", "Положение Workspace изменилось. Обновите каталог.");
      }
      if (!Object.hasOwn(payload,"target")) refuse("FOLDER_IDENTITY_REQUIRED", "Обновите каталог папок.");
      const target = payload.target === null ? null : this.requireFolder(payload.target?.id,payload.target?.revision);
      if ((current?.id ?? null) === (target?.id ?? null)) refuse("FOLDER_UNCHANGED", "Workspace уже находится в этой папке.");
      this.updateMembership(row,target?.name ?? "");
      return { workspaceId: row.id, workspaceName: row.name, folder: folderOf(target) };
    }
    refuse("FOLDER_ACTION_INVALID", "Неизвестная операция каталога.");
  }
  input({ requestId, action, payload }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u.test(requestId ?? "") || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Folder command identity and exact payload are required");
    }
    return { requestId, action, payload, argumentsHash: commandFingerprint({ action, payload }) };
  }
  result(input) {
    const { requestId, argumentsHash } = this.input(input);
    if (input.expectedArgumentsHash && input.expectedArgumentsHash !== argumentsHash) throw new Error("Folder command arguments binding changed");
    const row = this.db.prepare("SELECT * FROM hub_workspace_folder_operations WHERE request_id=?").get(requestId);
    if (!row) return { requestId, argumentsHash, status: "unknown" };
    if (row.arguments_hash !== argumentsHash) throw new Error("Folder command identity binding changed");
    return JSON.parse(row.receipt_json);
  }
  command(input) {
    const { requestId, action, payload, argumentsHash } = this.input(input);
    return this.transaction(() => {
      const existing = this.result(input);
      if (existing.status !== "unknown") return existing;
      let receipt;
      try {
        const result = this.transaction(() => this.apply(action,payload));
        receipt = { requestId, argumentsHash, status: "succeeded", result };
      } catch (error) {
        if (!(error instanceof WorkspaceFolderConflict)) throw error;
        receipt = { requestId, argumentsHash, status: "rejected", error: { code: error.code, message: error.message, ...error.details } };
      }
      this.db.prepare("INSERT INTO hub_workspace_folder_operations(request_id,arguments_hash,receipt_json) VALUES(?,?,?)")
        .run(requestId,argumentsHash,JSON.stringify(receipt));
      return receipt;
    });
  }
}
