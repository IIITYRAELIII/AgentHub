import path from "node:path";

import { applyTeamRateLimitAccountBackfill } from "../../infrastructure/persistence/rate-limit-account-backfill.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const databaseFile = argument("--database");
const participant = argument("--participant");
if (!databaseFile || !participant) {
  throw new Error("Usage: rate-limit-account-backfill.mjs --database <journal.sqlite> --participant <github-login>");
}

const result = await applyTeamRateLimitAccountBackfill({
  databaseFile: path.resolve(databaseFile),
  participant,
});
console.log(JSON.stringify(result, null, 2));
