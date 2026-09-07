(function queueComposerReturnBootstrap(global) {
  "use strict";

  function create(dependencies) {
    const d = dependencies;
    const inflight = new Map();

    async function execute({ id, taskId, guard }) {
      let prepared = null;
      let applied = null;
      try {
        prepared = await d.prepare(id);
        if (!prepared?.token || d.bindingTaskId(prepared.binding) !== taskId) {
          throw new Error("Сообщение очереди относится к другому композеру");
        }
        const draft = {
          ...prepared.draft,
          attachments: await Promise.all(
            (prepared.draft?.attachments ?? []).map(d.materializeAttachment),
          ),
        };
        applied = d.applyDraft(guard, draft, { id, token: prepared.token });
        if (!applied) {
          throw new Error("Основной композер изменился; сообщение осталось в очереди");
        }
        try {
          const result = await d.commit(id, prepared.token);
          d.applySnapshot(await d.readSnapshot());
          d.notify(result?.message ?? "Сообщение возвращено в композер");
          return result;
        } catch (error) {
          const authoritative = await d.readSnapshot().catch(() => null);
          const stillQueued = authoritative ? d.itemPresent(authoritative, id) : null;
          if (stillQueued === false) {
            d.applySnapshot(authoritative);
            d.notify("Сообщение возвращено в композер");
            return { accepted: true, id, reconciled: true };
          }
          if (stillQueued === true) {
            d.rollbackDraft(applied);
            applied = null;
            await d.release(id, prepared.token);
            prepared = null;
            d.applySnapshot(await d.readSnapshot());
          }
          throw authoritative
            ? error
            : new Error("Не удалось подтвердить перенос; черновик сохранён, очередь требует проверки");
        }
      } catch (error) {
        if (prepared && !applied) await d.release(id, prepared.token).catch(() => {});
        throw error;
      }
    }

    function run(request) {
      const id = String(request?.id ?? "").trim();
      if (!id) return Promise.reject(new Error("Не указано сообщение очереди"));
      if (inflight.has(id)) return inflight.get(id);
      const operation = execute(request);
      inflight.set(id, operation);
      void operation.then(
        () => { if (inflight.get(id) === operation) inflight.delete(id); },
        () => { if (inflight.get(id) === operation) inflight.delete(id); },
      );
      return operation;
    }

    return Object.freeze({ run });
  }

  global.AgentHubQueueComposerReturn = Object.freeze({ create });
})(window);
