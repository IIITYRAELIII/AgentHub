import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [composerSource, transactionSource] = await Promise.all([
  readFile(new URL("../../assets/web-app/messages/composer-draft-reconciliation.js", import.meta.url), "utf8"),
  readFile(new URL("../../assets/web-app/messages/send-transaction.js", import.meta.url), "utf8"),
]);
const context = vm.createContext({ window: {}, atob, btoa, TextEncoder });
vm.runInContext(composerSource, context);
vm.runInContext(transactionSource, context);
const ComposerDraft = context.window.AgentHubComposerDraftReconciliation;
const SendTransaction = context.window.AgentHubMessageSendTransaction;

function emptyDraft() {
  return { text: "", attachments: [], taskReferences: [], annotations: [] };
}

function pending(overrides = {}) {
  const value = {
    requestId: "request-1",
    taskId: "task-1",
    rawText: "Исходное сообщение",
    attachments: [],
    taskReferences: [],
    annotations: [],
    restoreOnReject: true,
    ...overrides,
  };
  value.fingerprint = ComposerDraft.recoveryFingerprint(value);
  return value;
}

function domHarness({ initialDraft = emptyDraft() } = {}) {
  const input = { value: String(initialDraft.text ?? "") };
  const surface = {
    attachments: [...(initialDraft.attachments ?? [])],
    taskReferences: [...(initialDraft.taskReferences ?? [])],
    annotations: [...(initialDraft.annotations ?? [])],
  };
  const drafts = new Map([["task-1", structuredClone(initialDraft)]]);
  const retries = new Map();
  const persisted = [];
  let renders = 0;
  const controller = ComposerDraft.create({
    drafts,
    retries,
    persist: () => persisted.push(JSON.stringify([...drafts.entries()])),
    render: (taskId) => {
      const draft = drafts.get(taskId) ?? emptyDraft();
      input.value = draft.text;
      surface.attachments = [...draft.attachments];
      surface.taskReferences = [...draft.taskReferences];
      surface.annotations = [...draft.annotations];
      renders += 1;
    },
  });
  const edit = (draft) => {
    input.value = String(draft.text ?? "");
    surface.attachments = [...(draft.attachments ?? [])];
    surface.taskReferences = [...(draft.taskReferences ?? [])];
    surface.annotations = [...(draft.annotations ?? [])];
    controller.save("task-1", {
      text: input.value,
      ...surface,
    }, { userEdited: true });
  };
  return { controller, drafts, edit, input, persisted, retries, surface, renders: () => renders };
}

test("accepted response leaves the production composer cleared", async () => {
  const dom = domHarness();
  const current = pending();
  const result = await SendTransaction.run({
    send: async () => ({ accepted: true, clientUserMessageId: current.requestId }),
    receive: async () => dom.controller.complete({
      pending: current,
      requestId: current.requestId,
      taskId: current.taskId,
      outcome: "accepted",
    }),
    reject: async () => assert.fail("accepted transport must not reject"),
    synchronize: async () => {},
    synchronizationFailed: async () => assert.fail("synchronization must succeed"),
  });

  assert.equal(result.accepted, true);
  assert.equal(dom.input.value, "");
  assert.equal(dom.retries.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(dom.drafts.get("task-1"))), emptyDraft());
});

test("authoritative rejection restores text and reuses the exact request identity", async () => {
  const dom = domHarness();
  const current = pending();
  let completion;
  await assert.rejects(SendTransaction.run({
    send: async () => { throw new Error("Введите сообщение"); },
    receive: async () => assert.fail("rejected transport must not receive"),
    reject: async () => {
      completion = dom.controller.complete({
        pending: current,
        requestId: current.requestId,
        taskId: current.taskId,
        outcome: "rejected",
      });
    },
    synchronize: async () => {},
    synchronizationFailed: async () => {},
  }), /Введите сообщение/u);

  assert.equal(completion.restored, true);
  assert.equal(dom.input.value, current.rawText);
  assert.equal(dom.drafts.get("task-1").recoveryRequestId, current.requestId);
  assert.deepEqual(JSON.parse(JSON.stringify(dom.retries.get("task-1"))), {
    requestId: current.requestId,
    fingerprint: current.fingerprint,
  });
});

test("rejected image and mixed Task/annotation payload is restored byte-for-byte in the DOM", () => {
  const image = { name: "screen.png", type: "image/png", dataUrl: "data:image/png;base64,AQID" };
  const taskReference = { kind: "task", taskId: "task-card-1", intent: "context" };
  const annotation = {
    quote: "selected text",
    annotation: "Проверь это",
    source: { version: 1, itemId: "agent-item-1", start: 4, end: 17 },
  };
  const dom = domHarness();
  const current = pending({
    rawText: "",
    attachments: [image],
    taskReferences: [taskReference],
    annotations: [annotation],
  });

  const completion = dom.controller.complete({
    pending: current,
    requestId: current.requestId,
    outcome: "rejected",
  });

  assert.equal(completion.restored, true);
  assert.deepEqual(dom.surface.attachments, [image]);
  assert.deepEqual(dom.surface.taskReferences, [taskReference]);
  assert.deepEqual(dom.surface.annotations, [annotation]);
});

test("timeout remains unknown without restoring a duplicate, then exact queued evidence settles it", () => {
  const dom = domHarness();
  const current = pending();
  const unknown = dom.controller.complete({
    pending: current,
    requestId: current.requestId,
    outcome: "unknown",
  });

  assert.equal(unknown.restored, false);
  assert.equal(unknown.retryable, true);
  assert.equal(dom.input.value, "");
  assert.equal(dom.renders(), 0);

  const queued = dom.controller.complete({
    pending: unknown.pending,
    requestId: current.requestId,
    taskId: current.taskId,
    outcome: "accepted",
  });
  assert.equal(queued.outcome, "accepted");
  assert.equal(dom.input.value, "");
  assert.equal(dom.retries.size, 0);
});

test("late exact durable evidence removes only its own restored draft", () => {
  const dom = domHarness();
  const current = pending();
  dom.controller.complete({ pending: current, requestId: current.requestId, outcome: "rejected" });
  assert.equal(dom.input.value, current.rawText);

  const settled = dom.controller.complete({
    pending: null,
    requestId: current.requestId,
    taskId: current.taskId,
    outcome: "accepted",
  });
  assert.equal(settled.cleared, true);
  assert.equal(dom.input.value, "");

  const other = pending({ requestId: "request-other", rawText: current.rawText });
  dom.controller.complete({ pending: other, requestId: other.requestId, outcome: "rejected" });
  const mismatch = dom.controller.complete({
    pending: null,
    requestId: current.requestId,
    taskId: current.taskId,
    outcome: "accepted",
  });
  assert.equal(mismatch.cleared, false);
  assert.equal(dom.input.value, current.rawText);
});

test("new user text after submission is never overwritten or cleared by rejection reconciliation", () => {
  const dom = domHarness();
  const current = pending({
    attachments: [{ name: "old.png", dataUrl: "data:image/png;base64,AQID" }],
  });
  dom.edit({ text: "Новый текст пользователя", attachments: [], taskReferences: [], annotations: [] });

  const rejected = dom.controller.complete({
    pending: current,
    requestId: current.requestId,
    outcome: "rejected",
  });
  assert.equal(rejected.restored, false);
  assert.equal(dom.input.value, "Новый текст пользователя");

  const accepted = dom.controller.complete({
    pending: null,
    requestId: current.requestId,
    taskId: current.taskId,
    outcome: "accepted",
  });
  assert.equal(accepted.cleared, false);
  assert.equal(dom.input.value, "Новый текст пользователя");
});

test("an edit revision irreversibly fences a late rejection even after content becomes empty again", () => {
  const dom = domHarness();
  const current = pending({ editRevision: dom.controller.revision("task-1") });
  dom.edit({ text: "temporary edit", attachments: [], taskReferences: [], annotations: [] });
  dom.edit(emptyDraft());

  const rejected = dom.controller.complete({
    pending: current,
    requestId: current.requestId,
    outcome: "rejected",
  });
  assert.equal(rejected.restored, false);
  assert.equal(rejected.retryable, false);
  assert.deepEqual(JSON.parse(JSON.stringify(dom.drafts.get("task-1"))), emptyDraft());
});

test("persisted restored draft is reconciled by exact identity after reload", () => {
  const beforeReload = domHarness();
  const current = pending({
    taskReferences: [{ kind: "task", taskId: "task-card-1", intent: "context" }],
    annotations: [{ quote: "Q", annotation: "A" }],
  });
  beforeReload.controller.complete({
    pending: current,
    requestId: current.requestId,
    outcome: "rejected",
  });
  const serialized = JSON.stringify([...beforeReload.drafts.entries()]);

  const restoredEntries = JSON.parse(serialized);
  const drafts = new Map();
  const retries = new Map();
  const input = { value: "" };
  const controller = ComposerDraft.create({
    drafts,
    retries,
    render: (taskId) => { input.value = drafts.get(taskId)?.text ?? ""; },
  });
  for (const [taskId, draft] of restoredEntries) controller.restore(taskId, draft);
  input.value = drafts.get("task-1").text;
  assert.deepEqual(JSON.parse(JSON.stringify(retries.get("task-1"))), {
    requestId: current.requestId,
    fingerprint: current.fingerprint,
  });
  const settled = controller.complete({
    pending: null,
    requestId: current.requestId,
    taskId: current.taskId,
    outcome: "accepted",
  });

  assert.equal(settled.cleared, true);
  assert.equal(input.value, "");
  assert.deepEqual(JSON.parse(JSON.stringify(drafts.get("task-1"))), emptyDraft());
});

test("request-only completion is allowed only for its captured pending transaction", () => {
  const dom = domHarness();
  const current = pending();
  const rejected = dom.controller.complete({
    pending: current,
    requestId: current.requestId,
    outcome: "rejected",
  });
  assert.equal(rejected.restored, true);

  const requestOnly = dom.controller.complete({
    pending: null,
    requestId: current.requestId,
    outcome: "accepted",
  });
  assert.equal(requestOnly.cleared, false);
  assert.equal(dom.input.value, current.rawText);

  const pendingOnly = pending({ requestId: "pending-only" });
  const accepted = dom.controller.complete({
    pending: pendingOnly,
    requestId: pendingOnly.requestId,
    outcome: "accepted",
  });
  assert.equal(accepted.matched, true);
});

test("reload reconstructs retry identity only for the exact recovered payload", () => {
  const current = pending({
    rawText: "Повтори после reload",
    attachments: [{
      name: "screen.png",
      type: "image/png",
      size: 3,
      dataUrl: "data:image/png;base64,AQID",
      uploadedPath: "C:\\expired\\screen.png",
    }],
  });
  const beforeReload = domHarness();
  beforeReload.controller.complete({ pending: current, requestId: current.requestId, outcome: "rejected" });
  const persisted = structuredClone(beforeReload.drafts.get("task-1"));
  persisted.attachments = ComposerDraft.recoveryAttachments(persisted.attachments);

  const afterReload = domHarness();
  afterReload.controller.restore("task-1", persisted);
  assert.equal(afterReload.retries.get("task-1").requestId, current.requestId);
  assert.equal(afterReload.drafts.get("task-1").attachments[0].uploadedPath, undefined);

  const stale = structuredClone(persisted);
  stale.text = `${stale.text} изменено`;
  afterReload.controller.restore("task-1", stale);
  assert.equal(afterReload.retries.has("task-1"), false);
  assert.equal(afterReload.drafts.get("task-1").recoveryRequestId, undefined);
});

test("legacy recovery metadata without a fingerprint keeps text but grants no retry identity", () => {
  const dom = domHarness();
  const restored = dom.controller.restore("task-1", {
    text: "Старый сохранённый текст",
    attachments: [],
    taskReferences: [],
    annotations: [],
    recoveryRequestId: "legacy-request",
  });
  assert.equal(restored.text, "Старый сохранённый текст");
  assert.equal(restored.recoveryRequestId, undefined);
  assert.equal(dom.retries.has("task-1"), false);
});

test("a user edit invalidates retry identity even when visible text stays equal", () => {
  const dom = domHarness();
  const current = pending();
  dom.controller.complete({ pending: current, requestId: current.requestId, outcome: "rejected" });
  assert.equal(dom.retries.has("task-1"), true);

  dom.edit({ text: current.rawText, attachments: [], taskReferences: [], annotations: [] });
  assert.equal(dom.retries.has("task-1"), false);
  assert.equal(dom.drafts.get("task-1").recoveryRequestId, undefined);
});

test("wrong-task accepted evidence cannot clear equal text or another retry identity", () => {
  const first = pending({ taskId: "task-1", requestId: "request-first", rawText: "одинаково" });
  const second = pending({ taskId: "task-2", requestId: "request-second", rawText: "одинаково" });
  const drafts = new Map();
  const retries = new Map();
  const controller = ComposerDraft.create({ drafts, retries });
  controller.complete({ pending: first, requestId: first.requestId, outcome: "rejected" });
  controller.complete({ pending: second, requestId: second.requestId, outcome: "rejected" });

  const mismatch = controller.complete({
    pending: null,
    requestId: first.requestId,
    taskId: "task-2",
    outcome: "accepted",
  });
  assert.equal(mismatch.cleared, false);
  assert.equal(drafts.get("task-2").text, "одинаково");
  assert.equal(retries.get("task-2").requestId, second.requestId);
});

test("quota or privacy failure retains current-page retry but persists no partial identity", () => {
  const drafts = new Map([["task-1", emptyDraft()]]);
  const retries = new Map();
  const persisted = [];
  const failures = [];
  const controller = ComposerDraft.create({
    drafts,
    retries,
    persist: (requirement) => {
      persisted.push({ requirement, draft: structuredClone(drafts.get("task-1")) });
      return !requirement?.requiredRecoveryRequestId;
    },
    persistenceFailed: (failure) => failures.push(failure),
  });
  const current = pending({
    rawText: "",
    attachments: [{ name: "only.png", type: "image/png", size: 3, dataUrl: "data:image/png;base64,AQID" }],
  });

  const completion = controller.complete({ pending: current, requestId: current.requestId, outcome: "rejected" });
  assert.equal(completion.restored, true);
  assert.equal(completion.durable, false);
  assert.equal(completion.retryable, true);
  assert.equal(drafts.get("task-1").attachments.length, 1);
  assert.equal(drafts.get("task-1").recoveryRequestId, undefined);
  assert.equal(drafts.get("task-1").recoveryNonDurable, true);
  assert.equal(persisted.at(-1).draft.recoveryRequestId, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(failures)), [{
    taskId: "task-1",
    requestId: current.requestId,
  }]);
});

test("attachment recovery accepts only canonical re-uploadable bytes and metadata", () => {
  const valid = {
    name: "screen.png",
    type: "image/png",
    size: 3,
    dataUrl: "data:image/png;base64,AQID",
  };
  assert.deepEqual(JSON.parse(JSON.stringify(ComposerDraft.recoveryAttachments([valid]))), [valid]);
  for (const invalid of [
    { ...valid, dataUrl: "data:image/png;base64,AQ=I" },
    { ...valid, dataUrl: "data:image/png;base64,AQI" },
    { ...valid, size: 2 },
    { ...valid, type: "IMAGE/PNG", dataUrl: "data:IMAGE/PNG;base64,AQID" },
    { ...valid, type: "text/plain", dataUrl: "data:image/png;base64,AQID" },
    { ...valid, name: "../screen.png" },
    { ...valid, name: "." },
    { ...valid, name: ".." },
    { ...valid, name: "NUL.txt" },
    { ...valid, name: "trailing. " },
    { ...valid, name: "c1\u0085.png" },
    { ...valid, name: "lone-\uD800.png" },
    { ...valid, name: `${"n".repeat(256)}.png` },
  ]) {
    assert.equal(ComposerDraft.recoveryAttachments([invalid]), null);
    assert.equal(ComposerDraft.recoveryFingerprint({ taskId: "task-1", attachments: [invalid] }), "");
  }
});

test("a full 20 MiB attachment is validated and fingerprinted iteratively", { timeout: 30_000 }, () => {
  const size = 20 * 1024 * 1024;
  const dataUrl = `data:application/octet-stream;base64,${Buffer.alloc(size).toString("base64")}`;
  const attachment = { name: "maximum.bin", type: "application/octet-stream", size, dataUrl };
  const canonical = ComposerDraft.recoveryAttachments([attachment]);
  assert.equal(canonical?.[0]?.size, size);
  const first = ComposerDraft.recoveryFingerprint({ taskId: "task-1", attachments: canonical });
  const second = ComposerDraft.recoveryFingerprint({ taskId: "task-1", attachments: canonical });
  assert.match(first, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(second, first);
  assert.equal(ComposerDraft.recoveryAttachments([
    attachment,
    { ...attachment, name: "overflow.bin", size: 1, dataUrl: "data:application/octet-stream;base64,AA==" },
  ]), null);
});

test("Task removal clears draft, retry and revision through the owner", () => {
  const current = pending();
  const drafts = new Map();
  const retries = new Map();
  const invalidated = [];
  const controller = ComposerDraft.create({
    drafts,
    retries,
    invalidateRecovery: (entry) => invalidated.push(entry),
  });
  controller.complete({ pending: current, requestId: current.requestId, outcome: "rejected" });
  controller.save("task-1", drafts.get("task-1"), { userEdited: true });
  controller.restore("task-1", {
    ...drafts.get("task-1"),
    recoveryRequestId: current.requestId,
    recoveryFingerprint: current.fingerprint,
  });
  assert.equal(controller.remove("task-1"), true);
  assert.equal(drafts.has("task-1"), false);
  assert.equal(retries.has("task-1"), false);
  assert.equal(controller.revision("task-1"), 0);
  assert.equal(invalidated.at(-1).requestId, current.requestId);
});

test("failed durable invalidation fences old recovery identity and reports once", () => {
  const current = pending();
  const drafts = new Map();
  const retries = new Map();
  const failures = [];
  const controller = ComposerDraft.create({
    drafts,
    retries,
    invalidateRecovery: () => false,
    persist: ({ invalidatedRecoveryRequestId } = {}) => !invalidatedRecoveryRequestId,
    persistenceFailed: (failure) => failures.push(failure),
  });
  controller.complete({ pending: current, requestId: current.requestId, outcome: "rejected" });
  const revision = controller.revision("task-1");
  const edited = controller.save("task-1", {
    ...drafts.get("task-1"),
    text: "new text",
  }, { userEdited: true });

  assert.equal(controller.revision("task-1"), revision + 1);
  assert.equal(retries.has("task-1"), false);
  assert.equal(edited.recoveryRequestId, undefined);
  assert.equal(edited.recoveryNonDurable, true);
  assert.deepEqual(JSON.parse(JSON.stringify(failures)), [{
    taskId: "task-1",
    requestId: current.requestId,
  }]);
});
