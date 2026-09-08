import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

test("usage help exposes versioned exact Astra prices", async (context) => {
  const browser = await chromium.launch(
    process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true },
  );
  context.after(() => browser.close());
  const page = await browser.newPage();
  const html = await readFile(
    new URL("../../assets/web-app/index.html", import.meta.url),
    "utf8",
  );
  await page.setContent(html.replace(/<script\b[\s\S]*?<\/script>/giu, ""));

  const help = page.locator("details.setting-note").filter({ hasText: "Как считается расход" });
  await help.evaluate((element) => {
    document.body.replaceChildren(element);
    document.body.removeAttribute("hidden");
    document.body.removeAttribute("class");
    element.hidden = false;
  });
  await help.locator("summary").click();
  const currentPrices = help.locator("li").filter({ hasText: "с 08.09.2026" });

  assert.equal(await help.getAttribute("open"), "");
  assert.equal(await currentPrices.isVisible(), true);
  assert.match(await currentPrices.innerText(), /GPT-6 Astra — \$10 \/ \$1 \/ \$50/u);
  assert.doesNotMatch(await help.innerText(), /×2,5 к Sol|База ×5/u);
});
