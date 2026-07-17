import assert from "node:assert/strict";
import test from "node:test";

import { findContainingProject, pathInsideOrSame, samePath } from "./config.mjs";


test("pathInsideOrSame accepts the project itself and nested caller directories", () => {
  assert.equal(pathInsideOrSame("C:\\Workspace", "C:\\Workspace"), true);
  assert.equal(pathInsideOrSame("C:\\Workspace\\Project\\src", "C:\\Workspace"), true);
  assert.equal(pathInsideOrSame("C:\\Workspace-other", "C:\\Workspace"), false);
});

test("findContainingProject chooses the most specific allowed project", () => {
  const projects = [
    { name: "Workspace", path: "C:\\Workspace" },
    { name: "Project", path: "C:\\Workspace\\Project" },
  ];
  assert.equal(
    findContainingProject(projects, "C:\\Workspace\\Project\\src").name,
    "Project",
  );
  assert.equal(findContainingProject(projects, "C:\\Other"), undefined);
});

test("samePath normalizes equivalent paths", () => {
  assert.equal(samePath("C:\\Workspace\\Project\\..\\Project", "C:\\Workspace\\Project"), true);
});
