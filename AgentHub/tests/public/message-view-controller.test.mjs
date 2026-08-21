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
    this.children = [...children];
    this.dataset = {};
    this.bulkReplacements = 0;
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

  replaceChildren(...children) {
    this.bulkReplacements += 1;
    this.children = [...children];
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
  assert.equal(container.bulkReplacements, 1);
});

test("long Thread switches render a bounded newest-message window", async () => {
  const api = await messageViewApi();
  const messages = Array.from({ length: 500 }, (_, index) => ({ id: `message-${index}` }));

  const visible = api.messageTailWindow(messages, 80);

  assert.equal(visible.length, 80);
  assert.equal(visible[0].id, "message-420");
  assert.equal(visible.at(-1).id, "message-499");
  assert.equal(messages.length, 500);
});

test("message count prefers full history while preserving newer live cards", async () => {
  const api = await messageViewApi();

  assert.equal(api.resolvedMessageCount(126, 811), 811);
  assert.equal(api.resolvedMessageCount(126, null), 126);
  assert.equal(api.resolvedMessageCount(812, 811), 812);
});

test("older history prepends only new nodes and preserves rendered suffix identity", async () => {
  const api = await messageViewApi();
  const previousMessages = [
    { id: "newer-1", role: "user", text: "Запрос" },
    { id: "newer-2", role: "agent", text: "Ответ" },
  ];
  const olderMessages = [
    { id: "older-1", role: "user", text: "Старый запрос" },
    { id: "older-2", role: "agent", text: "Старый ответ" },
  ];
  const nextMessages = [...olderMessages, ...previousMessages];
  assert.equal(api.prependedMessageCount(previousMessages, nextMessages), 2);

  const existing = previousMessages.map((message) => {
    const node = new FakeNode(api.messageKey(message));
    node.dataset.messageKey = api.messageKey(message);
    node.dataset.messageContentSignature = api.messageContentSignature(message);
    return node;
  });
  const container = new FakeContainer(existing);
  const prefixSpecs = olderMessages.map((message) => ({
    key: api.messageKey(message),
    signature: api.messageContentSignature(message),
    message,
  }));
  let created = 0;
  const prepended = api.reconcilePrependedKeyedChildren(
    container,
    prefixSpecs,
    existing.map((node) => node.dataset.messageKey),
    (spec) => {
      created += 1;
      return new FakeNode(spec.key);
    },
  );

  assert.equal(created, 2);
  assert.equal(prepended.length, 2);
  assert.equal(container.children.length, 4);
  assert.equal(container.children[2], existing[0]);
  assert.equal(container.children[3], existing[1]);
});

test("prepend optimization rejects changed existing history", async () => {
  const api = await messageViewApi();
  const previous = [{ id: "same", role: "agent", text: "Первый ответ" }];
  const changed = [
    { id: "older", role: "user", text: "Старый запрос" },
    { id: "same", role: "agent", text: "Исправленный ответ" },
  ];

  assert.equal(api.prependedMessageCount(previous, changed), 0);
});

test("prepend optimization accepts equivalent projections but rejects changed metadata", async () => {
  const api = await messageViewApi();
  const previous = [{ id: "same", role: "user", text: "Запрос", delivery: "Доставлено" }];
  const equivalent = [
    { id: "older", role: "agent", text: "Старый ответ" },
    { ...previous[0] },
  ];
  const changed = [equivalent[0], { ...previous[0], delivery: "Ошибка", failed: true }];

  assert.equal(api.prependedMessageCount(previous, equivalent), 1);
  assert.equal(api.prependedMessageCount(previous, changed), 0);
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

test("message disclosure switches between registered collapse and expand icons", async () => {
  const api = await messageViewApi();
  assert.deepEqual(
    { ...api.messageDisclosurePresentation(false) },
    { label: "Показать ещё", icon: "caret-down" },
  );
  assert.deepEqual(
    { ...api.messageDisclosurePresentation(true) },
    { label: "Свернуть", icon: "caret-up" },
  );
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

test("user messages bypass technical-tail extraction and preserve punctuation exactly", async () => {
  const api = await messageViewApi();
  for (const text of [
    "...",
    "!?",
    "почему ... в моём сообщении превращается в .\nа ? - вообще не отображается иногда..",
    "Коммит 6a863064 — это часть моего сообщения!?",
  ]) {
    const content = api.messageTechnicalContent("user", text);
    assert.equal(content.text, text);
    assert.deepEqual(Array.from(content.rows), []);
  }
});

test("agent technical-tail extraction preserves repeated and standalone punctuation", async () => {
  const api = await messageViewApi();
  assert.equal(api.extractTechnicalTails("Ответ... Правда!? ???").text, "Ответ... Правда!? ???");
  assert.equal(api.messageTechnicalContent("system", "!?...").text, "!?...");
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
