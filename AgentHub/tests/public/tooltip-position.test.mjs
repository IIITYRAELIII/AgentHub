import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function tooltipApi() {
  const source = await readFile(
    new URL("../../assets/web-app/tooltip-position.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubTooltipPosition;
}

test("chart tooltip position is clamped away from chart edges", async () => {
  const { tooltipPosition } = await tooltipApi();
  const first = tooltipPosition(-1, 2);
  const second = tooltipPosition(0.95, 0.02);

  assert.equal(first.x, 0.08);
  assert.equal(first.y, 0.86);
  assert.equal(first.side, "right");
  assert.equal(second.x, 0.92);
  assert.equal(second.y, 0.14);
  assert.equal(second.side, "left");
});

test("chart tooltip positioning writes CSS coordinates and side", async () => {
  const { applyTooltipPosition } = await tooltipApi();
  const element = {
    dataset: {},
    style: {},
  };

  const position = applyTooltipPosition(element, 0.95, 0.02);

  assert.equal(position.x, 0.92);
  assert.equal(position.y, 0.14);
  assert.equal(position.side, "left");
  assert.equal(element.style.left, "92%");
  assert.equal(element.style.top, "14%");
  assert.equal(element.dataset.side, "left");
});
