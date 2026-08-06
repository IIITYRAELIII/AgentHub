import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../../assets/mini-app/app.js", import.meta.url), "utf8");

test("annotation menu escapes clipped themes and stays inside the chat edge", () => {
  assert.match(app, /document\.body\.append\(annotationContextMenu\)/u);
  assert.match(
    app,
    /const chatRect = event\.target\.closest\?\.\("\[data-chat\]"\)\?\.getBoundingClientRect\(\)/u,
  );
  assert.match(app, /Math\.min\(viewportMaxLeft, chatMaxLeft\)/u);
});
