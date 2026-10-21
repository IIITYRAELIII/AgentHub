import path from "node:path";

import { applyTeamRateLimitAccountBackfill } from "../../infrastructure/persistence/rate-limit-account-backfill.mjs";
import { loadLegacyTeamUsageAccountPolicy } from "../../infrastructure/filesystem/config.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const databaseFile = argument("--database");
const participant = argument("--participant");
if (!databaseFile || !participant) {
  throw new Error("Usage: rate-limit-account-backfill.mjs --database <journal.sqlite> --participant <github-login> [--config <private-config.json>]");
}

const policy = await loadLegacyTeamUsageAccountPolicy({ configPath: argument("--config") });
if (!policy) throw new Error("Explicit legacy account backfill requires a private configured policy");
const result = await applyTeamRateLimitAccountBackfill({
  databaseFile: path.resolve(databaseFile),
  participant,
  policy,
});
console.log(JSON.stringify(result, null, 2));
