// Development compatibility entry; dependency discovery and execution are external.
import { releaseRecipeModule } from "./src/infrastructure/process/release-recipe.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { recipe } = await releaseRecipeModule();
export const { WranglerDependencyError, detectGitCommonDirectory, resolveWrangler, ensureWrangler, runWrangler } =
  recipe.wranglerTools({ sourceRoot: import.meta.dirname });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWrangler(process.argv.slice(2));
