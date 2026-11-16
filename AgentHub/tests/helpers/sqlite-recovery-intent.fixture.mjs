import * as fs from "node:fs/promises";
import path from "node:path";

// Model an already persisted legacy recovery, before its first file move.
// Ordinary starts deliberately do not create this authority.
export async function seedSqliteRecoveryIntent(databaseFile) {
  const quarantineDirectory = `${databaseFile}.quarantine-interrupted-fixture`;
  await fs.mkdir(quarantineDirectory);
  await fs.writeFile(`${databaseFile}.recovery-intent.json`, JSON.stringify({
    version: 1, state: "quarantining", recoveryId: "saved-recovery",
    instanceId: "previous-process", databaseFile, quarantineDirectory,
    files: [{ source: databaseFile, destination: path.join(quarantineDirectory, path.basename(databaseFile)) }],
  }));
}
