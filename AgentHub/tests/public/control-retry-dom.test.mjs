import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture, submit } from "./composer-production.fixture.mjs";

for (const mode of ["blank gateway", "application refusal"]) {
  test(`complete HTTP client preserves command identity through ${mode}`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = await openFixture(page, { surface: "web" });
      await page.evaluate(() => { window.__agentHubFixture.mode = "accept"; });
      const requests = [];
      await page.route("**/api/control", async route => {
        const body = route.request().postDataJSON();
        if (body.action !== "send-message") return route.fallback();
        requests.push(body);
        if (mode === "application refusal") return route.fulfill({ status: 400, contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "Synthetic application refusal" }) });
        if (requests.length <= 3) return route.fulfill({ status: 502, body: "" });
        return route.fallback();
      });
      await submit(page, { text: "Same original message" });
      if (mode === "blank gateway") {
        await page.waitForFunction(() => window.__agentHubFixture.log.some(value => value.action === "send-message"));
        assert.equal(requests.length, 4);
        for (const request of requests) {
          assert.equal(request.commandId, requests[0].commandId);
          assert.equal(request.params.clientUserMessageId, requests[0].params.clientUserMessageId);
          assert.equal(request.params.clientTiming.submittedAtMs, requests[0].params.clientTiming.submittedAtMs);
          assert.equal(request.params.text, "Same original message");
        }
      } else {
        await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Same original message");
        assert.equal(requests.length, 1, "a definite application refusal cannot be retried as a blank gateway failure");
      }
      // HTTP error responses themselves are expected browser diagnostics here;
      // a page exception still fails independently of network status logging.
      assert.equal(errors.some(value => !value.includes("Failed to load resource")), false);
    } finally { await browser.close(); }
  });
}
