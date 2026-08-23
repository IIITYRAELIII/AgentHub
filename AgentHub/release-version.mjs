import { fileURLToPath } from "node:url";
import path from "node:path";

import { prepareAgentHubReleaseVersion } from "./src/infrastructure/filesystem/release-version.mjs";

export async function prepareReleaseVersion() {
  const result = await prepareAgentHubReleaseVersion();
  console.log(result.changed
    ? `Версия Agent Hub повышена: v${result.previousVersion || "—"} → v${result.version}.`
    : `Версия Agent Hub уже актуальна: v${result.version}.`);
  return result;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  prepareReleaseVersion().catch((error) => {
    console.error(`Не удалось подготовить версию Agent Hub: ${error.message}`);
    process.exitCode = 1;
  });
}
