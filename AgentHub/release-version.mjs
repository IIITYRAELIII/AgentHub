// Development compatibility entry; version policy belongs to the external recipe.
import { releaseRecipeModule } from "./src/infrastructure/process/release-recipe.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export async function prepareReleaseVersion() {
  const { recipe } = await releaseRecipeModule();
  return recipe.versionCommand({ sourceRoot: import.meta.dirname });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { recipe } = await releaseRecipeModule();
  console.log(JSON.stringify(await recipe.versionCommand({ sourceRoot: import.meta.dirname, args: process.argv.slice(2) })));
}
