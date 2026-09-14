import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../../assets/web-app/directory-field.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(source, { window });
const directoryField = window.AgentHubDirectoryField;

test("directory field builds breadcrumbs for Windows, UNC and POSIX paths", () => {
  assert.deepEqual(
    Array.from(directoryField.pathSegments("D:\\projects\\Utilities\\AgentHub")),
    ["D:", "projects", "Utilities", "AgentHub"],
  );
  assert.deepEqual(
    Array.from(directoryField.pathSegments("\\\\server\\share\\repo")),
    ["\\\\server\\share", "repo"],
  );
  assert.deepEqual(Array.from(directoryField.pathSegments("/srv/agent-hub")), ["/", "srv", "agent-hub"]);
});

test("directory field collapses only the middle of a long path", () => {
  const segments = Array.from(
    directoryField.breadcrumbSegments("D:\\one\\two\\three\\four\\five\\six"),
    (segment) => ({ label: segment.label, collapsed: segment.collapsed }),
  );
  assert.deepEqual(segments, [
    { label: "D:", collapsed: false },
    { label: "…", collapsed: true },
    { label: "four", collapsed: false },
    { label: "five", collapsed: false },
    { label: "six", collapsed: false },
  ]);
});
