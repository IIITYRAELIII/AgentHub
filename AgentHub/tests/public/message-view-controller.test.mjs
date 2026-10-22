import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { mergeDurableTaskHistory } from "../../src/interfaces/desktop/desktop-task-history.mjs";

async function messageViewApi() {
  const disclosureSource = await readFile(
    new URL("../../assets/web-app/messages/disclosure.js", import.meta.url),
    "utf8",
  );
  const source = await readFile(
    new URL("../../assets/web-app/message-view-controller.js", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(disclosureSource, context);
  vm.runInContext(source, context);
  return context.AgentHubMessageView;
}

class FakeNode {
  constructor(name) {
    this.name = name;
    this.dataset = {};
  }
}

test("Markdown details parser recognizes complete structure and keeps code and malformed tags literal", async () => {
  const api = await messageViewApi();
  for (const [source, summary, body] of [
    ['<details><summary>Title</summary>Body</details>', 'Title', 'Body'],
    ['<details>\n<summary>\nLong **title**\ncontinued\n</summary>\nBody\n</details>', 'Long **title**\ncontinued', 'Body'],
    ['<details open onclick="bad()">\n\n<summary onfocus="bad()">Title</summary>\nBody\n</details>', 'Title', 'Body'],
    ['<details>\n<summary>Outer</summary>\n<details><summary>Inner</summary>\nText\n</details>\n</details>', 'Outer', '<details><summary>Inner</summary>\nText\n</details>'],
    ['<details><summary>Code</summary>\n~~~json\n</details>\n~~~\n</details>', 'Code', '~~~json\n</details>\n~~~'],
  ]) {
    const lines = source.split('\n');
    const parsed = api.markdownDetailsAt(lines, 0);
    assert.equal(parsed.summary, summary);
    assert.equal(parsed.body, body);
    assert.equal(parsed.nextIndex, lines.length);
  }
  for (const literal of [
    '`<details><summary>Code</summary></details>`',
    '<details>\n<summary>Missing end</summary>\nText',
    '<details>\nNo summary\n</details>',
    '&lt;details&gt;\n<summary>Escaped</summary>\n</details>',
  ]) assert.equal(api.markdownDetailsAt(literal.split('\n'), 0), null);
});

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

class FakeDetails {
  constructor(open = false) {
    this.open = open;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

test("collapsed activity disclosure materializes only while it is open", async () => {
  const api = await messageViewApi();
  const details = new FakeDetails(false);
  const content = new FakeContainer();
  let renderCount = 0;
  const render = (target, label) => {
    renderCount += 1;
    target.replaceChildren(new FakeNode(label));
  };
  const controller = api.createDeferredDisclosureController(
    details,
    content,
    (target) => render(target, "first"),
  );

  assert.equal(controller.materialized, false);
  assert.equal(renderCount, 0);
  assert.deepEqual(content.children, []);

  details.open = true;
  details.dispatch("toggle");
  assert.equal(controller.materialized, true);
  assert.equal(renderCount, 1);
  assert.equal(content.children[0].name, "first");

  details.dispatch("toggle");
  assert.equal(renderCount, 1);

  details.open = false;
  details.dispatch("toggle");
  assert.equal(controller.materialized, false);
  assert.deepEqual(content.children, []);

  controller.update((target) => render(target, "updated"));
  assert.equal(renderCount, 1);
  details.open = true;
  details.dispatch("toggle");
  assert.equal(renderCount, 2);
  assert.equal(content.children[0].name, "updated");
});

test("long user messages expose a bounded preview without parsing the full body", async () => {
  const api = await messageViewApi();
  const text = `${"Большой межпоточный отчёт. ".repeat(220)}ФИНАЛ`;
  const preview = api.deferredUserMessagePreview({ role: "user", text });

  assert.ok(preview);
  assert.ok(preview.length <= 1_602);
  assert.ok(preview.endsWith("\n…"));
  assert.equal(preview.includes("ФИНАЛ"), false);
  assert.equal(api.deferredUserMessagePreview({ role: "agent", text }), null);
  assert.equal(api.deferredUserMessagePreview({ role: "user", text: "Короткий запрос" }), null);
  const annotatedPreview = api.deferredUserMessagePreview({
    role: "user",
    text,
    responseAnnotations: [{ text: "цитата", annotation: "комментарий" }],
  });
  assert.ok(annotatedPreview);
  assert.ok(annotatedPreview.length <= 1_602);
  assert.match(annotatedPreview, /^Цитата 1\nцитата\nкомментарий/u);
});

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

test("long Thread history reveals bounded local pages", async () => {
  const api = await messageViewApi();

  assert.deepEqual({ ...api.messageTailPagination(1_383, 40, 40) }, {
    loadedCount: 1_383,
    visibleCount: 40,
    hiddenCount: 1_343,
    nextCount: 40,
  });
  assert.deepEqual({ ...api.messageTailPagination(65, 40, 40) }, {
    loadedCount: 65,
    visibleCount: 40,
    hiddenCount: 25,
    nextCount: 25,
  });
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

test("explicit active-turn steer remains distinct from queued input", async () => {
  const api = await messageViewApi();
  assert.equal(api.composerFollowUpMode({ running: true }), "queue");
  assert.equal(
    api.composerFollowUpMode({ running: true }, { steerWhileRunning: true }),
    "steer",
  );
  assert.equal(api.composerFollowUpMode({ running: false }), "queue");
  assert.equal(
    api.composerFollowUpMode({ running: false }, { steerWhileRunning: true }),
    "steer",
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

test("fenced blocks expose their exact text for clipboard copy", async () => {
  const api = await messageViewApi();
  assert.deepEqual(
    { ...api.codeBlockCopyRequest("SELECT\n  Заказ.Ссылка\nИЗ Заказ") },
    { text: "SELECT\n  Заказ.Ссылка\nИЗ Заказ", successMessage: "Блок скопирован" },
  );
  assert.deepEqual(
    { ...api.codeBlockCopyRequest("```powershell\nкоманда\n```") },
    { text: "команда", successMessage: "Блок скопирован" },
  );
  assert.deepEqual(
    { ...api.codeBlockCopyRequest("```powershell\nкоманда") },
    { text: "команда", successMessage: "Блок скопирован" },
  );
  assert.equal(api.codeBlockCopyRequest(""), null);
});

test("durable intake staging stays in the command queue as starting", async () => {
  const api = await messageViewApi();
  assert.deepEqual(
    { ...api.deferredQueueCounts([
      { state: "queued", conflictKind: "message-intake" },
      { state: "queued", conflictKind: "task-running" },
      { state: "pending", conflictKind: "active-run" },
      { state: "paused", conflictKind: "message-intake" },
    ]) },
    { pending: 1, starting: 1, queued: 1, paused: 1 },
  );
});

test("standalone inline code is promoted to a copyable block", async () => {
  const api = await messageViewApi();
  assert.equal(
    api.standaloneInlineCode('  `Set-CASMailbox -Identity "mailbox@example.invalid"`  '),
    'Set-CASMailbox -Identity "mailbox@example.invalid"',
  );
  assert.equal(api.standaloneInlineCode("Команда: `npm run contour:refresh`"), null);
  assert.equal(api.standaloneInlineCode("`один` и `два`"), null);
});

test("inline Markdown tokens keep angle-wrapped file targets intact", async () => {
  const api = await messageViewApi();
  const text = "Готово: [Пример_проверки_маршрута.mp4](</mnt/d/projects/example/path (draft)/Пример_проверки_маршрута.mp4>)";

  assert.deepEqual(JSON.parse(JSON.stringify(api.inlineMarkdownTokens(text))), [{
    index: "Готово: ".length,
    token: "[Пример_проверки_маршрута.mp4](</mnt/d/projects/example/path (draft)/Пример_проверки_маршрута.mp4>)",
  }]);
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

test("technical-tail presentation preserves whole commit links and adjacent prose", async () => {
  const api = await messageViewApi();
  for (const link of [
    "[Коммит e145a50f уже в main](https://github.com/example/repo/commit/e145a50f)",
    "[Коммит `e145a50f`](<https://example.com/path (draft)/e145a50f>)",
    "[Runtime abcdef12](https://example.com/runtime)",
  ]) {
    const line = `${link}. Прямое обновление установлено.`;
    const result = api.messageTechnicalContent("agent", line + "\nКоммит 1234abcd отправлен.");
    assert.equal(result.text, line);
    assert.deepEqual(Array.from(result.rows, row => ({ ...row })), [
      { label: "КОММИТ", value: "1234abcd", note: "отправлен." },
    ]);
    assert.equal(api.inlineMarkdownTokens(result.text)[0].token, link);
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

test("agent citation displays the user comment and targets its annotation card by canonical identity", async () => {
  const api = await messageViewApi();
  const messages = [{
    id: "user-1",
    clientUserMessageId: "client-1",
    role: "user",
    text: "Почему?",
    responseAnnotations: [{ text: "привести", annotation: "123" }],
  }, {
    id: "agent-1",
    role: "agent",
    text: "Цитата 1\nПричина найдена",
    responseAnnotationReferences: [{ index: 1 }],
  }];

  assert.deepEqual(
    JSON.parse(JSON.stringify(api.responseCitationPresentations(messages, 1))),
    [{
      index: 1,
      label: "Цитата 1",
      quote: "123",
      annotation: "123",
      targetMessageKey: "client\u001fclient-1",
      interactive: true,
    }],
  );
  assert.equal(
    api.withoutResponseCitationFallbacks(messages[1].text, messages[1].responseAnnotationReferences),
    "Причина найдена",
  );
});

test("a source locator never overrides the annotation-card target for duplicate selected text", async () => {
  const api = await messageViewApi();
  const digest = (letter) => `sha256:${letter.repeat(64)}`;
  const source = (itemId, start) => ({
    version: 1,
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-source",
    itemId,
    role: "agent",
    messageKey: `provider\u001fcodex\u001fthread-1\u001fturn-source\u001f${itemId}\u001fagent`,
    surfaceKind: "message-body",
    surfaceIndex: 0,
    start,
    end: start + 6,
    contentHash: digest("a"),
    surfaceHash: digest("b"),
    selectionHash: digest("c"),
  });
  const messages = [{
    id: "annotation-message",
    role: "user",
    responseAnnotations: [
      { text: "повтор", annotation: "первая", source: source("source-1", 0) },
      { text: "повтор", annotation: "вторая", source: source("source-2", 8) },
    ],
  }, {
    id: "answer",
    role: "agent",
    responseAnnotationReferences: [{ index: 2 }],
  }];
  const [presentation] = api.responseCitationPresentations(messages, 1);
  assert.equal(presentation.quote, "вторая");
  assert.equal(presentation.source.itemId, "source-2");
  assert.equal(presentation.source.start, 8);
  assert.equal(api.responseCitationControl(presentation).source, undefined);
  assert.equal(api.responseCitationControl(presentation).targetMessageKey, "id\u001fannotation-message");
});

test("only annotations with a validated source render keyboard-operable source controls", async () => {
  const api = await messageViewApi();
  const digest = (letter) => `sha256:${letter.repeat(64)}`;
  const identity = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-user",
    itemId: "user-item",
    role: "user",
  };
  const source = {
    version: 1,
    ...identity,
    messageKey: `provider\u001fcodex\u001fthread-1\u001fturn-user\u001fuser-item\u001fuser`,
    surfaceKind: "message-body",
    surfaceIndex: 0,
    start: 0,
    end: 3,
    contentHash: digest("a"),
    surfaceHash: digest("b"),
    selectionHash: digest("c"),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(api.responseAnnotationCardControl({ source }))), {
    tagName: "button",
    interactive: true,
    source,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.responseAnnotationCardControl({}))), {
    tagName: "div",
    interactive: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.responseAnnotationCardControl({
    source: { ...source, itemId: "wrong-item" },
  }))), {
    tagName: "div",
    interactive: false,
  });
});

test("Web history projections retain only unique bounded citation references", async () => {
  const api = await messageViewApi();
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.normalizedResponseAnnotationReferences([
      { index: 1 },
      { index: 1 },
      { index: 20 },
      { index: 21 },
      { index: Number.MAX_SAFE_INTEGER + 1 },
    ]))),
    [{ index: 1 }, { index: 20 }],
  );
});

test("coalesced terminal citation remains a clickable Web control after reload", async () => {
  const api = await messageViewApi();
  const turnId = "turn-terminal-citation";
  const [turn] = mergeDurableTaskHistory([{
    id: turnId,
    messages: [{
      itemId: `${turnId}:rollout-user:0`,
      clientUserMessageId: "client-terminal-citation",
      role: "user",
      responseAnnotations: [{ text: "Точная цитата", annotation: "Проверить" }],
    }, {
      itemId: "provider-final-item",
      role: "agent",
      phase: "final",
      text: "Цитата 1\nГотово",
      responseAnnotationReferences: [{ index: 1 }],
    }],
  }], [{
    id: turnId,
    messages: [{
      itemId: `${turnId}:rollout-agent:final`,
      role: "agent",
      text: "Цитата 1\nГотово",
    }],
  }]);
  const agentIndex = turn.messages.findIndex((message) => message.role === "agent");
  const presentations = api.responseCitationPresentations(turn.messages, agentIndex);

  assert.equal(turn.messages.filter((message) => message.role === "agent").length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(api.responseCitationControl(presentations[0]))), {
    tagName: "button",
    className: "msg-response-citation",
    interactive: true,
    label: "Цитата 1",
    quote: "Проверить",
    index: 1,
    targetMessageKey: "client\u001fclient-terminal-citation",
  });
});

test("duplicate response references produce one interactive citation control", async () => {
  const api = await messageViewApi();
  const messages = [{
    clientUserMessageId: "client-1",
    role: "user",
    responseAnnotations: [{ text: "Одна цитата", annotation: "Проверить" }],
  }, {
    role: "agent",
    responseAnnotationReferences: [{ index: 1 }, { index: 1 }],
  }];
  const presentations = api.responseCitationPresentations(messages, 1);
  assert.equal(presentations.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.responseCitationControl(presentations[0]))),
    {
      tagName: "button",
      className: "msg-response-citation",
      interactive: true,
      label: "Цитата 1",
      quote: "Проверить",
      index: 1,
      targetMessageKey: "client\u001fclient-1",
    },
  );
});

test("missing and out-of-range citation mappings render readable non-interactive fallbacks", async () => {
  const api = await messageViewApi();
  const messages = [{
    clientUserMessageId: "client-1",
    role: "user",
    responseAnnotations: [{ text: "Только первая", annotation: "Проверить" }],
  }, {
    role: "agent",
    responseAnnotationReferences: [{ index: 2 }, { index: 21 }, { index: Number.MAX_SAFE_INTEGER + 1 }],
  }];
  const presentations = api.responseCitationPresentations(messages, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(presentations)), [{
    index: 2,
    label: "Цитата 2",
    quote: "",
    annotation: "",
    targetMessageKey: "",
    interactive: false,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.responseCitationControl(presentations[0]))), {
    tagName: "span",
    className: "msg-response-citation is-fallback",
    interactive: false,
    label: "Цитата 2",
    quote: "",
  });
  const missingTarget = api.responseCitationPresentations([{
    role: "agent",
    responseAnnotationReferences: [{ index: 1 }],
  }], 0);
  assert.deepEqual(JSON.parse(JSON.stringify(api.responseCitationControl(missingTarget[0]))), {
    tagName: "span",
    className: "msg-response-citation is-fallback",
    interactive: false,
    label: "Цитата 1",
    quote: "",
  });
});

test("citation mapping never turns user literal text into a response link", async () => {
  const api = await messageViewApi();
  const messages = [{ role: "user", text: ':codex-annotation{index="1"}' }, {
    role: "agent",
    text: "Цитата 1 — обычный текст",
  }];
  assert.deepEqual(JSON.parse(JSON.stringify(api.responseCitationPresentations(messages, 1))), []);
  assert.equal(api.withoutResponseCitationFallbacks(messages[1].text, []), messages[1].text);
});

test("conversation renderer keeps idle optimism but excludes queue-owned users", async () => {
  const api = await messageViewApi();
  const values = api.conversationSurfaceMessages([
    { id: "optimistic", role: "user", projectionState: "optimistic" },
    { id: "queued", role: "user", projectionState: "queued", deliveryState: "queued" },
    { id: "dispatching", role: "user", projectionState: "queued", deliveryState: "sending" },
    { id: "ambiguous", role: "user", projectionState: "unknown", deliveryState: "unconfirmed" },
    { id: "rejected", role: "user", projectionState: "unknown", deliveryState: "rejected" },
    { id: "accepted", role: "user", providerAccepted: true, projectionState: "active" },
    { id: "terminal", role: "user", projectionState: "completed" },
    { id: "agent", role: "agent", projectionState: "queued", deliveryState: "queued" },
  ]);

  assert.deepEqual(values.map((message) => message.id), ["optimistic", "accepted", "terminal", "agent"]);
  assert.equal(api.messageOwnsDeferredQueue({
    role: "user",
    projectionState: "optimistic",
    deliveryState: "sending",
  }), false);
  assert.equal(api.messageOwnsDeferredQueue({
    role: "user",
    projectionState: "queued",
    deliveryState: "sending",
  }), true);
  assert.equal(api.messageOwnsDeferredQueue({
    role: "user",
    providerAccepted: true,
    projectionState: "active",
  }), false);
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

test("message timestamp includes the date only outside the current local day", async () => {
  const api = await messageViewApi();
  const now = new Date(2026, 7, 22, 12, 0);

  assert.equal(api.messageTimestampLabel(new Date(2026, 7, 22, 9, 5), now), "09:05");
  assert.equal(api.messageTimestampLabel(new Date(2026, 7, 21, 22, 47), now), "21.08.2026 22:47");
});

test("completed turn duration is formatted in hours and minutes", async () => {
  const api = await messageViewApi();

  assert.equal(api.turnDurationLabel("2026-08-22T10:00:00.000Z", "2026-08-22T10:00:42.000Z"), "<1 мин");
  assert.equal(api.turnDurationLabel("2026-08-22T10:00:00.000Z", "2026-08-22T11:08:00.000Z"), "1 ч 8 мин");
  assert.equal(api.turnDurationLabel("", "2026-08-22T11:08:00.000Z"), "");
});

test("cancelled agent card shows stopped on creation, update and reload", async () => {
  const api = await messageViewApi();
  const children = [];
  const head = {
    ownerDocument: { createElement: () => ({
      setAttribute(name, value) { this[name] = value; },
      remove() { children.splice(children.indexOf(this), 1); },
    }) },
    querySelector: () => children.find((child) => child["data-turn-status"]) ?? null,
    append: (child) => children.push(child),
  };
  const message = { role: "agent", projectionState: "active", text: "HUB_UI_STOP_READY" };
  api.syncTurnStatus(head, message);
  assert.equal(children.length, 0);
  const projectionContext = vm.createContext({});
  projectionContext.window = projectionContext;
  vm.runInContext(await readFile(
    new URL("../../assets/web-app/messages/projection.js", import.meta.url), "utf8",
  ), projectionContext);
  const stopped = { ...message, projectionState: projectionContext.AgentHubMessageProjection
    .projectionState({ status: "aborted", terminalRevision: 1 }), terminalRevision: 1 };
  assert.equal(projectionContext.AgentHubMessageProjection
    .projectionState({ status: "interrupted", terminalRevision: 1 }), "cancelled");
  api.syncTurnStatus(head, stopped);
  assert.equal(children.length, 1);
  assert.equal(children[0].textContent, "Остановлен");
  assert.equal(children[0]["data-turn-status"], "cancelled");
  api.syncTurnStatus(head, JSON.parse(JSON.stringify(stopped)));
  assert.equal(children.length, 1);
  assert.equal(children[0].textContent, "Остановлен");
  assert.equal(api.prependedMessageCount([message], [{ id: "older" }, stopped]), 0);
  for (const next of [
    { ...stopped, role: "user" },
    { ...stopped, kind: "subagent" },
    { ...stopped, projectionState: "completed" },
    { ...stopped, projectionState: "unknown" },
  ]) {
    api.syncTurnStatus(head, next);
    assert.equal(children.length, 0);
    api.syncTurnStatus(head, stopped);
  }
});

test("running turn duration accepts the live clock timestamp", async () => {
  const api = await messageViewApi();

  assert.equal(
    api.turnDurationLabel("2026-08-22T10:00:00.000Z", Date.parse("2026-08-22T10:27:42.000Z")),
    "27 мин",
  );
});
