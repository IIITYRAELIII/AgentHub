import assert from "node:assert/strict";
import test from "node:test";

import { extractWorkLogHtml } from "./mini-app-server.mjs";

test("Mini App keeps the fresh rate-limit summary above projected days", () => {
  const html = extractWorkLogHtml([
    "# Глобальный журнал работ",
    "",
    '<div data-work-log-rate-limits data-sampled-at="2026-07-29T13:33:33.061Z">'
      + "<strong>Лимиты:</strong> CODEX - 89.0%</div>",
    "",
    "<details data-work-log-day-section>",
    "<summary data-work-log-day><strong>29.07.2026</strong></summary>",
    "</details>",
  ].join("\n"));
  assert.match(html, /^<div data-work-log-rate-limits/u);
  assert.match(html, /CODEX - 89\.0%/u);
  assert.match(html, /data-work-log-day-section/u);
  assert.doesNotMatch(html, /Глобальный журнал работ/u);
});
