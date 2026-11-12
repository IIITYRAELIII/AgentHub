import { releaseRecipeModule } from "./src/infrastructure/process/release-recipe.mjs";
import { releasePublicationPlatform } from "./src/composition/release-tooling-composition.mjs";
const chunks = [];
if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8").trim();
const { recipe } = await releaseRecipeModule();
if (typeof recipe.command !== "function") throw new Error("Pinned recipe has no command API");
const result = await recipe.command({ sourceRoot: import.meta.dirname, args: process.argv.slice(2),
  input: raw ? JSON.parse(raw) : null, platform: releasePublicationPlatform() });
console.log(JSON.stringify({ result }));
