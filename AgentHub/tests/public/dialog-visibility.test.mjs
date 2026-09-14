import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

test("closed native dialogs stay absent despite author layout styles", async (context) => {
  const browser = await launchBrowser();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const diagnostics = await openFixture(page);
  // A component may choose grid/flex independently of the native open state.
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "visibility-dialog";
    dialog.style.display = "grid";
    dialog.innerHTML = '<input aria-label="Dialog value"><button type="button">Close</button>';
    dialog.querySelector("button").onclick = () => dialog.close();
    document.body.append(dialog);
  });
  const dialog = page.locator("#visibility-dialog");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await dialog.evaluate((element) => element.getClientRects().length), 0);
    await dialog.evaluate((element) => element.showModal());
    assert.equal(await dialog.isVisible(), true);
    await dialog.locator("input").fill("editable");
    assert.equal(await dialog.locator("input").inputValue(), "editable");
    await dialog.locator("button").click();
    assert.equal(await dialog.isVisible(), false);
    await dialog.evaluate((element) => element.showModal());
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#visibility-dialog").open);
    assert.equal(await dialog.isVisible(), false);
  }
  assert.deepEqual(diagnostics, []);
});
