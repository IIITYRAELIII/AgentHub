import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function messageViewApi() {
  const source = await readFile(
    new URL("../../assets/web-app/message-view-controller.js", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.AgentHubMessageView;
}

class FakeNode {
  constructor(name) {
    this.name = name;
    this.dataset = {};
  }
}

class FakeContainer {
  constructor(children = []) {
    this.children = children;
    this.dataset = {};
  }

  insertBefore(node, reference) {
    const previous = this.children.indexOf(node);
    if (previous >= 0) this.children.splice(previous, 1);
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index >= 0 ? index : this.children.length, 0, node);
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
  }
}

test("switching Stream ownership discards the previous dialog DOM", async () => {
  const api = await messageViewApi();
  const oldMessage = { id: "shared-id", role: "agent", text: "Фрагмент Журнала" };
  const nextMessage = { id: "shared-id", role: "agent", text: "Фрагмент Дизайна" };
  const spec = (message) => ({
    key: api.messageKey(message),
    signature: api.messageContentSignature(message),
    message,
  });
  const container = new FakeContainer();
  let created = 0;
  const create = (value) => {
    const node = new FakeNode(`node-${++created}`);
    node.text = value.message.text;
    return node;
  };

  api.claimKeyedChildrenOwner(container, "journal");
  api.reconcileKeyedChildren(container, [spec(oldMessage)], create);
  const journalNode = container.children[0];

  assert.equal(api.claimKeyedChildrenOwner(container, "design"), true);
  assert.equal(container.children.length, 0);
  api.reconcileKeyedChildren(container, [spec(nextMessage)], create);

  assert.notEqual(container.children[0], journalNode);
  assert.equal(container.children[0].text, "Фрагмент Дизайна");
  assert.equal(container.dataset.messageOwnerKey, "design");
});

test("claiming an empty Stream removes the previous Stream fragment immediately", async () => {
  const api = await messageViewApi();
  const previous = new FakeNode("previous-dialog-fragment");
  const container = new FakeContainer([previous]);
  container.dataset.messageOwnerKey = "journal";

  api.claimKeyedChildrenOwner(container, "empty-stream");

  assert.deepEqual(container.children, []);
  assert.equal(container.dataset.messageOwnerKey, "empty-stream");
});

test("selected Stream rerenders when logical chat state and DOM ownership diverge", async () => {
  const appSource = await readFile(
    new URL("../../assets/web-app/app.js", import.meta.url),
    "utf8",
  );

  assert.match(
    appSource,
    /const taskChanged = activeChatId !== task\.id\s*\|\| String\(chatLog\.dataset\.messageOwnerKey \?\? ""\) !== String\(task\.id \?\? ""\)/u,
  );
  assert.equal(
    (appSource.match(/if \(sameMessages && \(taskId !== state\.selectedId \|\| selectedSurfaceOwned\)\) return;/gu) ?? []).length,
    2,
  );
});

test("Enter queues active-turn input while Ctrl+Enter steers it into the turn", async () => {
  const api = await messageViewApi();
  const appSource = await readFile(
    new URL("../../assets/web-app/app.js", import.meta.url),
    "utf8",
  );
  assert.equal(api.composerFollowUpMode({ running: true }), "queue");
  assert.equal(
    api.composerFollowUpMode({ running: true }, { steerWhileRunning: true }),
    "steer",
  );
  assert.equal(api.composerFollowUpMode({ running: false }), null);
  assert.equal(
    api.composerFollowUpMode({ running: false }, { steerWhileRunning: true }),
    null,
  );
  assert.match(
    appSource,
    /submitComposer\(\{ steerWhileRunning: event\.ctrlKey \|\| event\.metaKey \}\)/u,
  );
  assert.match(
    appSource,
    /deferWhileRunning: task\?\.running === true && !steerWhileRunning/u,
  );
});

test("textual user and agent messages expose the exact copy request", async () => {
  const api = await messageViewApi();
  assert.deepEqual(
    { ...api.messageCopyRequest({ role: "user", text: "  Текст сообщения\n" }) },
    { text: "  Текст сообщения\n", successMessage: "Сообщение скопировано" },
  );
  assert.deepEqual(
    { ...api.messageCopyRequest({ role: "agent", text: "Ответ" }) },
    { text: "Ответ", successMessage: "Сообщение скопировано" },
  );
  assert.equal(api.messageCopyRequest({ role: "system", text: "Событие" }), null);
  assert.equal(api.messageCopyRequest({ role: "user", text: "   " }), null);
});

test("message action rows expose copy, edit and repeat below the content", async () => {
  const [appSource, clientSource, dialogStyles] = await Promise.all([
    readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/hub-client.js", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/dialog-area.css", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /action: "copy"/u);
  assert.match(appSource, /action: "edit"/u);
  assert.match(appSource, /action: "repeat"/u);
  assert.match(appSource, /createPhosphorIcon\(document, icon, "msg-action-icon"\)/u);
  assert.doesNotMatch(appSource, /el\("svg", \{[\s\S]*"data-phosphor-icon": "copy"/u);
  assert.match(appSource, /onClick: \(\) => emit\("clipboard:write", request\)/u);
  assert.match(appSource, /class: `msg-stack msg-stack-\$\{role\}`/u);
  assert.match(clientSource, /agentHub\.toast\(String\(successMessage \?\? ""\)\.trim\(\) \|\|/u);
  assert.match(dialogStyles, /\.msg-actions \{[\s\S]*align-self: flex-start;[\s\S]*opacity: 0;[\s\S]*position: absolute;/u);
  assert.match(dialogStyles, /\.msg-stack:hover > \.msg-actions,[\s\S]*opacity: 1;/u);
  assert.match(dialogStyles, /\.msg-action:hover,[\s\S]*background: var\(--dialog-control-hover\)/u);
});

test("technical runtime and commit identifiers are extracted from prose", async () => {
  const api = await messageViewApi();
  const extracted = api.extractTechnicalTails(
    "Полный npm test прошёл. Коммит `6a863064` отправлен в main. Runtime 20260817174851-85853e88 развёрнут.",
  );
  assert.deepEqual(Array.from(extracted.rows, (row) => ({ ...row })), [
    { label: "КОММИТ", value: "6a863064", note: "отправлен в main." },
    { label: "RUNTIME", value: "20260817174851-85853e88", note: "развёрнут." },
  ]);
  assert.equal(extracted.text, "Полный npm test прошёл.");
  assert.equal(extracted.text.includes("6a863064"), false);
  assert.equal(extracted.text.includes("20260817174851-85853e88"), false);
});

test("context compaction events use the designed separator and arrow", async () => {
  const api = await messageViewApi();
  assert.equal(
    api.normalizeSystemEventText("Свёртка завершена успешно 35%>12%"),
    "Свёртка контекста · 35% → 12%",
  );
  assert.equal(api.normalizeSystemEventText("Обычное системное событие"), "Обычное системное событие");
});

test("optimistic confirmation keeps the same message node when content is unchanged", async () => {
  const api = await messageViewApi();
  const optimistic = {
    id: "local:client-1",
    clientUserMessageId: "client-1",
    role: "user",
    text: "Не мигай",
    responseAnnotations: [],
    responseAnnotationRequest: "Не мигай",
    delivery: "Отправляется…",
  };
  const durable = {
    ...optimistic,
    id: "codex:thread:turn:item:user",
    turnId: "turn",
    itemId: "item",
    responseAnnotationRequest: undefined,
    delivery: "В очереди",
  };
  const firstSpec = {
    key: api.messageKey(optimistic),
    signature: api.messageContentSignature(optimistic),
    message: optimistic,
  };
  const secondSpec = {
    key: api.messageKey(durable),
    signature: api.messageContentSignature(durable),
    message: durable,
  };
  const container = new FakeContainer();
  let created = 0;
  const create = () => new FakeNode(`node-${++created}`);
  api.reconcileKeyedChildren(container, [firstSpec], create);
  const selectedNode = container.children[0];
  api.reconcileKeyedChildren(container, [secondSpec], create, (node, spec) => {
    node.delivery = spec.message.delivery;
  });

  assert.equal(container.children[0], selectedNode);
  assert.equal(container.children[0].delivery, "В очереди");
  assert.equal(created, 1);
});

test("rendered annotation content still changes the message signature", async () => {
  const api = await messageViewApi();
  const message = {
    id: "local:client-1",
    clientUserMessageId: "client-1",
    role: "user",
    text: "Уточнение",
    responseAnnotations: [{ text: "Цитата", annotation: "Комментарий" }],
    responseAnnotationRequest: "Первый запрос",
  };
  assert.notEqual(
    api.messageContentSignature(message),
    api.messageContentSignature({ ...message, responseAnnotationRequest: "Другой запрос" }),
  );
});

test("message reconciliation leaves unchanged sibling nodes attached", async () => {
  const api = await messageViewApi();
  const messages = [
    { id: "one", role: "agent", text: "Выделенный текст" },
    { id: "two", role: "agent", text: "Сосед" },
  ];
  const specs = messages.map((message) => ({
    key: api.messageKey(message),
    signature: api.messageContentSignature(message),
    message,
  }));
  const container = new FakeContainer();
  const create = (spec) => new FakeNode(spec.key);
  api.reconcileKeyedChildren(container, specs, create);
  const selectedNode = container.children[0];
  const updated = [specs[0], {
    key: specs[1].key,
    signature: api.messageContentSignature({ ...messages[1], text: "Обновлён" }),
    message: { ...messages[1], text: "Обновлён" },
  }];
  api.reconcileKeyedChildren(container, updated, create);

  assert.equal(container.children[0], selectedNode);
  assert.equal(container.children.length, 2);
});
