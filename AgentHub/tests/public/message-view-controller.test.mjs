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

test("ordinary input during an active turn goes straight to the queue", async () => {
  const api = await messageViewApi();
  assert.equal(api.composerFollowUpMode({ running: true }), "queue");
  assert.equal(api.composerFollowUpMode({ running: false }), null);
});

test("optimistic confirmation keeps the same message node when content is unchanged", async () => {
  const api = await messageViewApi();
  const optimistic = {
    id: "local:client-1",
    clientUserMessageId: "client-1",
    role: "user",
    text: "Не мигай",
    delivery: "Отправляется…",
  };
  const durable = {
    ...optimistic,
    id: "codex:thread:turn:item:user",
    turnId: "turn",
    itemId: "item",
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
