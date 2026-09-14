import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot, bridgeCalls } from "./composer-production.fixture.mjs";

function question(key, streamId, overrides = {}) {
  return { key, kind: "async-user-input", streamId, threadId: "source-thread", turnId: "source-turn", itemId: key,
    state: "pending", text: "Можно ответить, пока агент продолжает работу.",
    questions: [{ id: "0", header: "Профиль", question: "Какой профиль использовать?",
      options: [{ label: "Первый", description: "" }, { label: "Второй", description: "" }] }], ...overrides };
}

test("async question cards retain drafts, follow Stream selection and retry only frozen answers", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(3_000);
  page.setDefaultNavigationTimeout(5_000);
  try {
    const initial = snapshot();
    initial.pendingApprovals = [question("question-a", "stream-a"), question("question-b", "stream-b")];
    const diagnostics = await openFixture(page, { fixtureSnapshot: initial });
    const card = page.locator('[data-approvals] .approval[data-approval-id="question-a"]');
    await card.waitFor({ state: "visible" });
    assert.equal(await card.locator(".approval-kind").textContent(), "Вопрос агента");
    assert.equal(await card.locator('input[type="radio"]:checked').count(), 0);
    assert.equal(await card.locator('[data-decision="once"], [data-decision="session"]').count(), 0);
    await card.locator("[data-approval-other]").fill("Свой профиль");
    await page.evaluate(() => { window.savedQuestionNode = document.querySelector('[data-approval-id="question-a"]'); });
    const changed = structuredClone(initial);
    changed.version = "neighbor-added";
    changed.pendingApprovals.push(question("neighbor", "stream-a"));
    await applyFixtureSnapshot(page, changed);
    await page.locator('[data-approvals] [data-approval-id="neighbor"]').first().waitFor();
    assert.equal(await card.locator("[data-approval-other]").inputValue(), "Свой профиль");
    assert.equal(await page.evaluate(() => window.savedQuestionNode === document.querySelector('[data-approval-id="question-a"]')), true);
    assert.equal((await bridgeCalls(page, "resolve-approval")).length, 0);

    await page.locator('[data-stream-task-id="stream-b"]').first().click();
    const other = page.locator('[data-approvals] .approval[data-approval-id="question-b"]');
    await other.waitFor({ state: "visible" });
    assert.equal(await card.count(), 0);
    const frozen = structuredClone(changed);
    frozen.version = "frozen";
    frozen.pendingApprovals[1] = question("question-b", "stream-b", {
      state: "dispatching", answers: { "0": ["Сохранённый ответ"] },
    });
    await applyFixtureSnapshot(page, frozen);
    await other.getByRole("button", { name: "Повторить отправку" }).waitFor();
    assert.equal(await other.locator("[data-approval-other]").inputValue(), "Сохранённый ответ");
    assert.equal(await other.locator("[data-approval-other]").isDisabled(), true);
    assert.equal(await other.locator('[data-decision="decline"]').count(), 0);
    assert.equal((await bridgeCalls(page, "resolve-approval")).length, 0);
    await other.getByRole("button", { name: "Повторить отправку" }).click();
    await page.waitForFunction(() => window.__agentHubFixture.log.some((entry) => entry.action === "resolve-approval"));
    const [request] = await bridgeCalls(page, "resolve-approval");
    assert.equal(request.params.key, "question-b");
    assert.equal(request.params.decision, "submit");
    assert.deepEqual(request.params.answers, { "0": ["Сохранённый ответ"] });
    const terminal = structuredClone(frozen);
    terminal.version = "submitted";
    terminal.pendingApprovals = terminal.pendingApprovals.filter((entry) => entry.key !== "question-b");
    await applyFixtureSnapshot(page, terminal);
    await other.waitFor({ state: "detached" });
    assert.equal(diagnostics.length, 0, diagnostics.join("\n"));
  } finally {
    await context.close();
    await browser.close();
  }
});
