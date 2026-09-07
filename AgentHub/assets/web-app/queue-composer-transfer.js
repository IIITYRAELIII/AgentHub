(function queueComposerTransferBootstrap(global) {
  "use strict";

  function filled(draft) {
    return Boolean(
      String(draft?.text ?? "").trim()
      || (draft?.attachments ?? []).length
      || (draft?.taskReferences ?? []).length
      || (draft?.annotations ?? []).length
    );
  }

  function create({ read, write, revision, notify }) {
    if (![read, write, revision, notify].every((value) => typeof value === "function")) {
      throw new TypeError("queue composer transfer requires state-owner callbacks");
    }

    function begin(taskId) {
      const current = read(taskId);
      if (filled(current)) {
        notify("Сначала очисти основной композер: в нём уже есть текст, вложения, Task или аннотации.");
        return null;
      }
      return Object.freeze({
        taskId: String(taskId ?? ""),
        revision: revision(),
      });
    }

    function apply(guard, draft, composerTransfer) {
      if (!guard || revision() !== guard.revision || filled(read(guard.taskId))) return null;
      const previous = read(guard.taskId);
      write(guard.taskId, {
        text: String(draft?.text ?? ""),
        attachments: Array.isArray(draft?.attachments) ? draft.attachments.slice() : [],
        taskReferences: Array.isArray(draft?.taskReferences) ? draft.taskReferences.slice() : [],
        annotations: Array.isArray(draft?.annotations) ? draft.annotations.slice() : [],
        messageOrigin: draft?.messageOrigin ?? null,
        composerTransfer: composerTransfer ?? null,
      });
      return Object.freeze({
        taskId: guard.taskId,
        previous,
        appliedRevision: revision(),
      });
    }

    function rollback(applied) {
      if (!applied || revision() !== applied.appliedRevision) return false;
      write(applied.taskId, applied.previous);
      return true;
    }

    return Object.freeze({ begin, apply, rollback });
  }

  global.AgentHubQueueComposerTransfer = Object.freeze({ create, filled });
})(window);
