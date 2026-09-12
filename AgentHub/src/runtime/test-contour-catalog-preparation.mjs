import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertContourOwnedPath } from "../infrastructure/filesystem/test-contour-external-effects.mjs";

// Only a writable COPY bearing the preparer's ownership marker is accepted.
// IDs, message bodies, annotations, journal records and ledger rows are outside
// this transform. Their canonical evidence is never globally string-replaced.
export function prepareContourCatalog({ databaseFile, preparedRoot, paths }) {
  if (!preparedRoot || !path.isAbsolute(preparedRoot) || !databaseFile || !path.isAbsolute(databaseFile)) throw new Error("Explicit prepared paths required");
  const root = assertContourOwnedPath(preparedRoot, preparedRoot);
  const markerFile = assertContourOwnedPath(path.join(root, "contour-preparation.json"), root);
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  if (marker.schemaVersion !== 1 || marker.kind !== "owned-contour-preparation" || marker.root !== root || marker.bootable !== false) throw new Error("Invalid contour preparation ownership marker");
  const file = assertContourOwnedPath(databaseFile, root);
  if (file === root || file === markerFile) throw new Error("Invalid catalog copy path");
  for (const suffix of ["-wal", "-shm"]) assertContourOwnedPath(`${file}${suffix}`, root, { optional: true });
  const db = new DatabaseSync(file);
  const counts = { workspaces: 0, streams: 0, threads: 0 };
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    for (const [table, field, counter] of [["hub_workspaces", "workingDirectory", "workspaces"], ["hub_streams", "project", "streams"]]) {
      const update = db.prepare(`UPDATE ${table} SET settings_json = ? WHERE id = ?`);
      for (const row of db.prepare(`SELECT id, settings_json FROM ${table}`).all()) {
        const settings = JSON.parse(row.settings_json);
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`Invalid ${table} settings`);
        if (settings[field] == null || settings[field] === "") continue;
        settings[field] = paths.map(settings[field], "project");
        update.run(JSON.stringify(settings), row.id);
        counts[counter]++;
      }
    }
    const updateThread = db.prepare("UPDATE hub_threads SET project_root = ? WHERE provider = ? AND provider_thread_id = ?");
    for (const row of db.prepare("SELECT provider, provider_thread_id, project_root FROM hub_threads").all()) {
      if (!row.project_root) continue;
      updateThread.run(paths.map(row.project_root, "project"), row.provider, row.provider_thread_id);
      counts.threads++;
    }
    db.exec("COMMIT;");
    return { schemaVersion: 1, status: "catalog-references-prepared", counts, bootable: false,
      preserved: ["workspace-stream-thread-identities", "canonical-journal", "command-ledger", "source-annotations"],
      remaining: ["runtime-projection-wiring", "ingress-canonical-fingerprint", "task-read-model-routing", "process-file-ownership", "media-delivery-adapters"] };
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw error;
  } finally { db.close(); }
}
