import { fileURLToPath } from "node:url";
import path from "node:path";

import { prepareAgentHubReleaseVersion } from "./src/infrastructure/filesystem/release-version.mjs";
import { artifactVersionIdentity, SEMVER_BUILD_SCHEME } from "./src/domain/agent-hub-version.mjs";

export async function prepareReleaseVersion() {
  const result = await prepareAgentHubReleaseVersion();
  console.log(result.changed
    ? `Версия Agent Hub повышена: v${result.previousVersion || "—"} → v${result.version}.`
    : `Версия Agent Hub уже актуальна: v${result.version}.`);
  return result;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] === "--android-artifact" ? async () => {
    if (process.argv.length !== 4) throw new Error("Exactly one frozen Android artifact version is required");
    const version = artifactVersionIdentity(process.argv[3]);
    if (version.versionScheme !== SEMVER_BUILD_SCHEME) throw new Error("Android artifact must carry a frozen build");
    console.log(JSON.stringify({ versionCode: version.buildNumber, versionName: version.publicVersion }));
  } : async () => {
    if (process.argv.length !== 2) throw new Error("Unknown release-version arguments");
    return prepareReleaseVersion();
  };
  action().catch((error) => {
    console.error(`Не удалось подготовить версию Agent Hub: ${error.message}`);
    process.exitCode = 1;
  });
}
