import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "../..");
test("CI runs all Agent Hub client checks without deployment", () => {
  const workflow = fs.readFileSync(
    path.resolve(ROOT, "..", ".github", "workflows", "agent-hub-ci.yml"),
    "utf8",
  );

  assert.match(workflow, /runs-on:\s*windows-latest/u);
  assert.match(workflow, /npm run test:all/u);
  assert.match(workflow, /npm test --prefix VSCodeExtension/u);
  assert.doesNotMatch(workflow, /AndroidApp[\\/]build\.ps1/u);
  assert.doesNotMatch(workflow, /worker:deploy|publish:all|runtime:deploy|wrangler deploy/u);
  assert.doesNotMatch(workflow, /\bsecrets\.[A-Za-z0-9_]+/u);
});
