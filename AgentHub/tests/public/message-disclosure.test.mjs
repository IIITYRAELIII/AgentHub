import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function disclosureApi() {
  const source = await readFile(new URL("../../assets/web-app/messages/disclosure.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubMessageDisclosure;
}

test("user message disclosure appears only for real visual overflow", async () => {
  const { USER_MESSAGE_COLLAPSE_HEIGHT_PX: height, hasCollapsedOverflow } = await disclosureApi();
  assert.equal(height, 448);
  assert.equal(hasCollapsedOverflow(height), false);
  assert.equal(hasCollapsedOverflow(height - 1), false);
  assert.equal(hasCollapsedOverflow(height + 1), true);
});

test("live activity disclosure starts closed and preserves only a manual opening", async () => {
  const { liveActivityDisclosureOpen } = await disclosureApi();
  assert.equal(liveActivityDisclosureOpen({ open: true, wasHidden: true, visible: true }), false);
  assert.equal(liveActivityDisclosureOpen({ open: true, wasHidden: false, visible: true }), true);
  assert.equal(liveActivityDisclosureOpen({ open: true, wasHidden: false, visible: false }), false);
});

test("live stage is rendered in the current activity title", async () => {
  const { liveActivityTitle, liveStageParts, standaloneLiveStageDetail } = await disclosureApi();
  const stage = liveStageParts("Ход выполняется · Анализирую задачу…");
  assert.equal(stage.status, "Ход выполняется");
  assert.equal(stage.detail, "Анализирую задачу…");
  assert.equal(standaloneLiveStageDetail({
    stage: "Ход выполняется · Codex принял ход. Ожидается первый ответ…",
  }), "Codex принял ход. Ожидается первый ответ…");
  assert.equal(standaloneLiveStageDetail({
    stage: "Ход выполняется · Анализирую задачу…",
    traceGroups: [{ id: "reasoning-1" }],
  }), "");
  assert.equal(
    liveActivityTitle({ count: 3, stage: "Анализирую задачу…" }),
    "Вызовы инструментов (3) · Анализирую задачу…",
  );
  assert.equal(
    liveActivityTitle({ label: "Выполненные действия", count: 2 }),
    "Выполненные действия (2)",
  );
});

test("live trace keeps reasoning blocks and collects every tool at the bottom", async () => {
  const {
    TURN_TRACE_ACTIVITY_GROUP_ID,
    liveTraceDisclosureOpen,
    turnTraceContent,
  } = await disclosureApi();
  const content = turnTraceContent([
    { reasoning: "Сначала проверяю.", activities: [{ id: "tool-1" }] },
    { reasoning: "Теперь исправляю.", activities: [{ id: "tool-2" }, { id: "tool-3" }] },
  ]);
  assert.deepEqual(Array.from(content.reasoningBlocks), ["Сначала проверяю.", "Теперь исправляю."]);
  assert.deepEqual(Array.from(content.activities, (activity) => activity.id), ["tool-1", "tool-2", "tool-3"]);
  assert.equal(
    liveTraceDisclosureOpen({
      groupId: TURN_TRACE_ACTIVITY_GROUP_ID,
      openGroupIds: [TURN_TRACE_ACTIVITY_GROUP_ID],
    }),
    true,
  );
  assert.equal(
    liveTraceDisclosureOpen({ groupId: TURN_TRACE_ACTIVITY_GROUP_ID, openGroupIds: [] }),
    false,
  );
});

test("completed trace names reasoning explicitly and counts all visible entries", async () => {
  const { turnTraceSummary } = await disclosureApi();
  assert.deepEqual(
    JSON.parse(JSON.stringify(turnTraceSummary({ reasoningCount: 2, activityCount: 3 }))),
    { label: "Рассуждения и действия", count: 5 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(turnTraceSummary({ reasoningCount: 2 }))),
    { label: "Рассуждения", count: 2 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(turnTraceSummary({ activityCount: 3 }))),
    { label: "Выполненные действия", count: 3 },
  );
});

test("quoting accepts one word from any surface inside one message", async () => {
  const { quotableSelectionText } = await disclosureApi();
  const message = {};
  assert.equal(quotableSelectionText({
    text: "runtime",
    rangeCount: 1,
    startMessage: message,
    endMessage: message,
    startSurface: {},
    endSurface: {},
  }), "runtime");
  assert.equal(quotableSelectionText({
    text: "два сообщения",
    rangeCount: 1,
    startMessage: {},
    endMessage: {},
    startSurface: {},
    endSurface: {},
  }), "");
  assert.equal(quotableSelectionText({
    text: "заголовок",
    rangeCount: 1,
    startMessage: message,
    endMessage: message,
  }), "");
});

test("native selection menu is preserved only for an actual touch gesture", async () => {
  const { nativeSelectionMenuRequired } = await disclosureApi();
  assert.equal(nativeSelectionMenuRequired({ pointerType: "mouse", recentTouch: false }), false);
  assert.equal(nativeSelectionMenuRequired({ pointerType: "mouse", recentTouch: true }), false);
  assert.equal(nativeSelectionMenuRequired({ pointerType: "touch", recentTouch: false }), true);
  assert.equal(nativeSelectionMenuRequired({ recentTouch: true }), true);
  assert.equal(nativeSelectionMenuRequired({ recentTouch: false }), false);
});

test("triple-click selection keeps the message when its range ends after the body", async () => {
  const { quotableSelectionScope } = await disclosureApi();
  const message = {};
  const surface = {};
  assert.deepEqual(JSON.parse(JSON.stringify(quotableSelectionScope({
    startMessage: message,
    intersectedMessage: message,
    startSurface: surface,
    intersectedSurface: surface,
  }))), {
    message,
    startSurface: surface,
    endSurface: surface,
  });
  assert.equal(quotableSelectionScope({
    startMessage: {},
    endMessage: {},
    intersectedMessage: message,
    intersectedSurface: surface,
  }), null);
});

test("shared shell keeps full text and limits only the rendered user-message body", async () => {
  const app = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../assets/web-app/dialog-area.css", import.meta.url), "utf8");
  assert.match(app, /body\.scrollHeight, USER_MESSAGE_COLLAPSE_HEIGHT_PX/u);
  assert.match(app, /if \(!existing\) bubble\.append\(button\)/u);
  assert.match(
    styles,
    /\.msg-user \.msg-body\.is-collapsed[\s\S]*max-height: var\(--user-message-collapse-height, 448px\)/u,
  );
  assert.match(styles, /\.msg-user \.msg-body\.is-collapsed::after[\s\S]*height: 38px/u);
  assert.match(styles, /\.msg-disclosure \{[\s\S]*margin: 0 0 0 -8px;/u);
});
