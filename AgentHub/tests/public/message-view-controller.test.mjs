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

test("only a textual user message exposes the exact copy request", async () => {
  const api = await messageViewApi();
  assert.deepEqual(
    { ...api.messageCopyRequest({ role: "user", text: "  Текст сообщения\n" }) },
    { text: "  Текст сообщения\n", successMessage: "Сообщение скопировано" },
  );
  assert.equal(api.messageCopyRequest({ role: "agent", text: "Ответ" }), null);
  assert.equal(api.messageCopyRequest({ role: "user", text: "   " }), null);
});

test("user message copy control has an outlined hover and forwards its toast", async () => {
  const [appSource, clientSource, styles] = await Promise.all([
    readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/hub-client.js", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /"data-message-copy": ""/u);
  assert.match(appSource, /button\.addEventListener\("click", \(\) => emit\("clipboard:write", request\)\)/u);
  assert.match(appSource, /if \(actions\) article\.insertBefore\(button, actions\)/u);
  assert.match(clientSource, /agentHub\.toast\(String\(successMessage \?\? ""\)\.trim\(\) \|\|/u);
  assert.match(styles, /\.msg-copy:hover,[\s\S]*border-color: var\(--accent-line\)/u);
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
