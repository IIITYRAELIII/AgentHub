import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8");

const fillRunning = (effect) => {
  const marker = `:root[data-stream-status-style="fill"][data-stream-status-effect="${effect}"]\n`
    + "  .task-workspace-item[data-running]::after,";
  const start = styles.indexOf(marker);
  assert.notEqual(start, -1, `нет правила заливки для ${effect}`);
  return styles.slice(start, styles.indexOf("\n}\n", start));
};

test("заливка хода занимает карточку целиком, а не полосу базового правила", () => {
  for (const effect of ["impulse", "scanner"]) {
    const rule = fillRunning(effect);
    // Базовое правило задаёт width в процентах и возит коробку translateX.
    // При заданных left и right ширина отменяет правый отступ, поэтому оба
    // свойства обязаны сниматься здесь, иначе «заливка» остаётся полосой.
    assert.match(rule, /\n  width: auto;/u, effect);
    assert.match(rule, /\n  transform: none;/u, effect);
    assert.match(rule, /\n  inset: 0;/u, effect);
  }
});

test("переливание идёт фоном двойной ширины и замыкается без разрыва", () => {
  for (const effect of ["impulse", "scanner"]) {
    const rule = fillRunning(effect);
    assert.match(rule, /animation: stream-fill-sweep \d/u, effect);
    assert.match(rule, /background-size: 200% 100%;/u, effect);
    // Крайние остановки градиента совпадают, иначе на стыке плиток был бы шов.
    const stops = rule.match(/color-mix\(in srgb, var\(--accent\) 46%, transparent\) (0%|100%)/gu);
    assert.equal(stops?.length, 2, effect);
  }
  assert.match(
    styles,
    /@keyframes stream-fill-sweep \{\s*from \{ background-position: 0 0; \}\s*to \{ background-position: 200% 0; \}/u,
  );
});

test("запрет движения повторён для заливки: общее правило её не перебивает", () => {
  const marker = ':root[data-stream-status-style="fill"][data-stream-status-effect="impulse"]\n'
    + "    .task-workspace-item[data-running]::after,";
  const start = styles.indexOf(marker);
  assert.notEqual(start, -1, "нет повтора запрета движения для заливки");
  const before = styles.slice(0, start);
  assert.ok(
    before.lastIndexOf("@media (prefers-reduced-motion: reduce) {") > before.lastIndexOf("\n}\n"),
    "повтор оказался вне блока prefers-reduced-motion",
  );
  const rule = styles.slice(start, styles.indexOf("\n  }\n", start));
  for (const effect of ["impulse", "scanner"]) {
    assert.ok(rule.includes(`[data-stream-status-effect="${effect}"]`), effect);
  }
  assert.match(rule, /animation: none;/u);
  assert.match(rule, /background-position: 0 0;/u);
});
