"use strict";
(() => {
  const MIME = "application/x-agent-hub-workspace";
  const plural = n => n % 10 === 1 && n % 100 !== 11 ? "воркспейс" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "воркспейса" : "воркспейсов";
  const singular = n => n % 10 === 1 && n % 100 !== 11;
  const movement = n => `${n} ${plural(n)} ${singular(n) ? "будет перемещён" : "будут перемещены"} в «Без папки».`;
  function create({ rail, getWorkspaces, isMobile, toast, focusResult, storageKey }) {
    let model = null, transport = null, modal = null, drag = null;
    const operations = new Map(), inFlight = new Set(), heldClosed = new Set();
    let lastAnnouncement = "";
    const node = (tag, text, attrs = {}) => {
      const item = document.createElement(tag);
      if (text) item.textContent = text;
      for (const [key,value] of Object.entries(attrs)) item.setAttribute(key,value);
      return item;
    };
    const live = node("div", "", { class: "folder-catalog-live", "aria-live": "polite", "aria-atomic": "true" });
    const notices = node("div", "", { class: "folder-catalog-notices", "data-folder-notices": "" });
    rail.before(live, notices);
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
      for (const item of saved) if (item?.input?.requestId && item.input.payload) operations.set(item.input.requestId,{ ...item, state: "unknown" });
      for (const id of JSON.parse(localStorage.getItem(`${storageKey}:closed-targets`) || "[]")) heldClosed.add(id);
    } catch { /* A corrupt recovery record never authorizes a submission. */ }
    function persist() { localStorage.setItem(storageKey,JSON.stringify([...operations.values()],(key,value) => key === "origin" ? undefined : value)); }
    function persistAfterAdmission() { try { persist(); } catch { /* Original pending input was saved before dispatch; keep it for readback. */ } }
    function persistClosed() { try { localStorage.setItem(`${storageKey}:closed-targets`,JSON.stringify([...heldClosed])); } catch { /* Presentation only. */ } }
    function announce(text) {
      if (text === lastAnnouncement) return;
      lastAnnouncement = text; live.textContent = text;
    }
    const byId = id => model?.folders.find(folder => folder.id === id);
    const byName = name => model?.folders.find(folder => folder.name === name);
    const workspace = id => getWorkspaces().find(item => item.id === id);
    function blocked({ folderId, workspaceId } = {}) {
      return [...operations.values()].some(item => item.meta.workspaceId && item.meta.workspaceId === workspaceId
        || item.meta.folderId && item.meta.folderId === folderId);
    }
    function clearDrag() {
      drag = null;
      rail.querySelectorAll("[data-folder-drag-source], [data-folder-drop-target]").forEach(item => {
        item.removeAttribute("data-folder-drag-source"); item.removeAttribute("data-folder-drop-target");
      });
    }
    function decorate() {
      for (const item of rail.querySelectorAll(".task-workspace-item[data-workspace-select]")) {
        const operation = [...operations.values()].find(record => record.meta.workspaceId === item.dataset.workspaceSelect);
        const unresolved = operation && operation.state !== "pending";
        const allowed = !isMobile() && workspace(item.dataset.workspaceSelect)?.kind === "user" && !blocked({ workspaceId: item.dataset.workspaceSelect });
        item.draggable = Boolean(model && allowed);
        item.toggleAttribute("data-folder-move-busy",blocked({ workspaceId: item.dataset.workspaceSelect }));
        item.toggleAttribute("data-folder-move-unknown",Boolean(unresolved));
        item.setAttribute("aria-busy",String(Boolean(operation && ["pending","checking"].includes(operation.state))));
        if (unresolved) item.setAttribute("aria-description","Результат предыдущего перемещения пока не подтверждён.");
        else item.removeAttribute("aria-description");
      }
      for (const item of rail.querySelectorAll('[data-workspace-folder-kind="folder"]')) {
        const folder = byName(item.dataset.workspaceFolderName);
        const busy = folder && blocked({ folderId: folder.id });
        item.toggleAttribute("data-folder-move-busy",Boolean(busy));
        const pending = folder && [...operations.values()].some(record => record.state === "pending" && record.meta.targetId === folder.id);
        item.toggleAttribute("data-folder-operation-pending",Boolean(pending));
        item.setAttribute("aria-busy",String(Boolean(pending || busy)));
        for (const control of item.querySelectorAll(":scope > [data-folder-menu], :scope > div > [data-mobile-folder-rename]")) {
          control.disabled = Boolean(busy || !model);
          if (busy) control.setAttribute("aria-description","Результат предыдущей операции пока не подтверждён.");
          else control.removeAttribute("aria-description");
        }
      }
    }
    function updateNotices() {
      const focusedId = document.activeElement?.closest("[data-folder-notice-id]")?.dataset.folderNoticeId;
      notices.replaceChildren();
      for (const record of operations.values()) {
        const unknown = record.state === "unknown" || record.state === "checking";
        if (!unknown) continue;
        const title = unknown ? `Результат ${record.input.action === "remove" ? "удаления" : record.input.action === "move" ? "перемещения" : "операции"} пока не подтверждён` : record.input.action === "remove" ? "Удаляем папку…" : "Сохраняем каталог…";
        const region = node("section", "", { role: "region", "aria-label": title, "data-folder-notice-id": record.input.requestId });
        region.append(node("strong",title));
        if (unknown) {
          region.append(node("p",record.input.action === "move"
            ? `Workspace „${record.meta.workspaceName}“ может уже находиться ${record.meta.targetName ? `в папке „${record.meta.targetName}“` : "в разделе „Без папки“"}. Показано текущее состояние каталога.`
            : record.input.action === "remove" ? "Папка могла быть удалена. Повторная команда не отправлена."
            : "Папка могла быть изменена. Повторная команда не отправлена."));
          const button = node("button",record.state === "checking" ? "Проверяем…" : "Проверить результат",{ type: "button", class: "board-task-primary" });
          button.setAttribute("aria-disabled",String(record.state === "checking"));
          button.addEventListener("click",() => void check(record)); region.append(button);
        }
        notices.append(region);
      }
      if (focusedId && !modal?.dialog.open) notices.querySelector(`[data-folder-notice-id="${CSS.escape(focusedId)}"] button`)?.focus({ preventScroll: true });
      decorate();
    }
    function errorNotice(text) {
      const alert = node("p",text,{ role: "alert", class: "folder-catalog-alert" });
      const close = node("button","Закрыть",{ type: "button", class: "board-task-quiet" });
      close.addEventListener("click",() => alert.remove()); alert.append(close); notices.append(alert);
    }
    async function read(action, params) {
      if (!transport) throw new Error("Каталог пока недоступен.");
      return transport.control(action,params);
    }
    function closeModal({ terminal = false } = {}) {
      if (!modal || modal.busy) return;
      const current = modal; modal = null;
      current.dialog.close(); current.dialog.remove();
      if (!terminal) focusResult({ kind: "cancel", origin: current.origin, record: current.record });
    }
    function errorInModal(text) {
      if (!modal) return errorNotice(text);
      modal.error.hidden = false; modal.error.textContent = text;
    }
    function unknownModal(record) {
      if (!modal || modal.record !== record) return;
      modal.busy = false; modal.mode = "unknown";
      modal.dialog.setAttribute("aria-busy","false");
      modal.title.textContent = `Результат ${record.input.action === "remove" ? "удаления" : "перемещения"} пока не подтверждён`;
      modal.summary.textContent = record.input.action === "remove" ? "Папка могла быть удалена. Повторная команда не отправлена." : "Workspace мог быть перемещён. Повторная команда не отправлена.";
      modal.helper.textContent = `Проверка результата безопасна и не повторяет ${record.input.action === "remove" ? "удаление" : "перемещение"}.`;
      modal.content.replaceChildren(); modal.error.hidden = true;
      modal.cancel.textContent = "Закрыть"; modal.cancel.disabled = false;
      modal.confirm.removeAttribute("aria-disabled");
      modal.confirm.className = "board-task-primary";
      modal.confirm.textContent = "Проверить результат"; modal.confirm.disabled = false;
      modal.confirm.onclick = () => void check(record);
    }
    function unknown(record) {
      record.state = "unknown";
      const announceEntry = !record.unknownAnnounced; record.unknownAnnounced = true;
      persistAfterAdmission(); unknownModal(record); updateNotices();
      if (announceEntry) announce("Результат операции пока не подтверждён.");
    }
    async function settle(record, receipt) {
      if (receipt?.requestId !== record.input.requestId || !["succeeded","rejected"].includes(receipt.status)) {
        unknown(record); return receipt;
      }
      if (record.argumentsHash && record.argumentsHash !== receipt.argumentsHash) throw new Error("Ответ относится к другой операции каталога.");
      record.argumentsHash = receipt.argumentsHash;
      operations.delete(record.input.requestId); persistAfterAdmission(); updateNotices();
      if (receipt.status === "succeeded") {
        if (record.input.action === "import") transport.onImported?.();
        if (modal?.record === record) { modal.busy = false; closeModal({ terminal: true }); }
        if (record.input.action !== "import") {
          const text = record.input.action === "remove"
            ? `Папка «${record.meta.folderName}» удалена.${receipt.result.members.length ? ` ${receipt.result.members.length} ${plural(receipt.result.members.length)} ${singular(receipt.result.members.length) ? "перемещён" : "перемещены"} в «Без папки».` : ""}`
            : record.input.action === "move" ? `Workspace „${record.meta.workspaceName}“ перемещён ${record.meta.targetName ? `в папку „${record.meta.targetName}“` : "в «Без папки»"}.`
            : record.input.action === "rename" ? `Папка переименована в «${receipt.result.folder.name}».` : `Папка «${receipt.result.folder.name}» создана.`;
          toast(text);
        }
        if (record.meta.keyboard || record.readbackActivated) focusResult({ kind: "success", record, receipt });
      } else {
        const message = !["remove","move"].includes(record.input.action)
          ? receipt.error.message
          : receipt.error.code === "FOLDER_STALE" || receipt.error.code === "FOLDER_ABSENT"
          ? record.input.action === "remove" ? "Состав папки изменился. Проверьте обновлённый список и подтвердите удаление ещё раз." : "Папка изменилась или удалена. Workspace не перемещён."
          : record.input.action === "remove" ? "Не удалось удалить папку. Изменения не применены." : "Не удалось переместить Workspace. Изменения отменены.";
        if (modal?.record === record && record.input.action === "move") {
          modal.busy = false; closeModal({ terminal: true });
          errorNotice(message); focusResult({ kind: "failure",record,receipt }); return receipt;
        }
        if (modal?.record === record) {
          modal.busy = false; modal.dialog.setAttribute("aria-busy","false");
          if (record.input.action === "remove" && receipt.error.preview) readyRemoval(receipt.error.preview);
          else if (record.input.action === "remove" && receipt.error.code === "FOLDER_ABSENT") {
            modal.mode = "absent"; modal.title.textContent = "Папка уже удалена в другом окне.";
            modal.summary.textContent = ""; modal.content.replaceChildren(); modal.confirm.hidden = true;
            modal.cancel.textContent = "Закрыть"; modal.cancel.disabled = false;
            modal.error.hidden = true; modal.cancel.focus({ preventScroll: true }); return receipt;
          } else {
            modal.cancel.disabled = false; modal.confirm.disabled = false;
            modal.confirm.textContent = record.input.action === "remove" ? "Удалить папку" : "Переместить";
          }
          errorInModal(message); modal.error.title = receipt.error.message;
          modal.confirm.focus({ preventScroll: true });
        } else { errorNotice(message); if (record.meta.keyboard || record.readbackActivated) focusResult({ kind: "failure",record,receipt }); }
      }
      return receipt;
    }
    async function submit(action, payload, meta = {}) {
      if (blocked({ workspaceId: meta.workspaceId, folderId: meta.folderId })
        || action === "move" && payload.target && blocked({ folderId: payload.target.id })) return null;
      if (action === "move" && payload.target) {
        const targetName = byId(payload.target.id)?.name;
        const row = [...rail.querySelectorAll("[data-workspace-folder-name]")].find(item => item.dataset.workspaceFolderName === targetName);
        if (row?.querySelector("details")?.open === false) { heldClosed.add(payload.target.id); persistClosed(); }
      }
      const input = { requestId: crypto.randomUUID(), action, payload };
      const record = { input, meta, state: "pending" };
      operations.set(input.requestId,record);
      try { persist(); } catch (error) {
        operations.delete(input.requestId); errorInModal("Не удалось сохранить исходный запрос. Команда не отправлена."); return null;
      }
      if (modal && ["remove","move","rename"].includes(action)) {
        modal.record = record; modal.busy = true; modal.dialog.setAttribute("aria-busy","true");
        modal.cancel.disabled = true; modal.confirm.setAttribute("aria-disabled","true");
        modal.confirm.textContent = action === "remove" ? "Удаляем папку…" : action === "move" ? "Перемещаем…" : "Сохраняем…";
      }
      updateNotices();
      announce(action === "remove" ? "Удаляем папку…" : action === "move"
        ? `Перемещаем Workspace „${meta.workspaceName}“ ${meta.targetName ? `в папку „${meta.targetName}“` : "в «Без папки»"}…` : "Сохраняем каталог…");
      try {
        const alias = action === "move" ? "move-workspace-to-folder" : action === "rename" ? "rename-workspace-folder" : "mutate-workspace-folder";
        const params = alias === "mutate-workspace-folder" ? input : { requestId: input.requestId, ...payload };
        const response = await read(alias,params);
        try { transport.applySnapshot(response); }
        catch { errorNotice("Получен результат операции. Не удалось обновить каталог."); }
        return await settle(record,response.workspaceFolderOperation);
      } catch { unknown(record); return { requestId: input.requestId, status: "unknown" }; }
    }
    async function check(record) {
      if (inFlight.has(record.input.requestId)) return;
      record.readbackActivated = true;
      inFlight.add(record.input.requestId); record.state = "checking"; updateNotices();
      if (modal?.record === record) { modal.confirm.setAttribute("aria-disabled","true"); modal.confirm.textContent = "Проверяем…"; }
      try {
        const receipt = await read("workspace-folder-result",{ ...record.input,
          ...(record.argumentsHash ? { expectedArgumentsHash: record.argumentsHash } : {}) });
        if (receipt.requestId !== record.input.requestId || !/^[a-f0-9]{64}$/u.test(receipt.argumentsHash ?? "")
          || record.argumentsHash && record.argumentsHash !== receipt.argumentsHash) throw new Error("Foreign folder receipt");
        record.argumentsHash = receipt.argumentsHash; persistAfterAdmission();
        if (receipt.status === "unknown") {
          unknown(record);
          if (!record.stillAnnounced) { record.stillAnnounced = true; announce("Результат всё ещё не подтверждён."); persistAfterAdmission(); }
        } else {
          try { const snapshot = await read("snapshot",{}); transport.applySnapshot(snapshot); }
          catch { errorNotice("Результат подтверждён. Не удалось обновить каталог."); }
          await settle(record,receipt);
        }
      } catch {
        unknown(record);
        errorInModal("Не удалось проверить результат. Повторная команда не отправлена.");
      } finally { inFlight.delete(record.input.requestId); }
    }
    function openShell(mode, title, origin) {
      if (modal) return null;
      const dialog = node("dialog","",{ class: "task-delete-modal folder-catalog-dialog", "data-folder-dialog": mode,
        "aria-labelledby": "folder-catalog-title", "aria-describedby": "folder-catalog-summary folder-catalog-helper" });
      const body = node("section"), footer = node("footer");
      const heading = node("h2",title,{ id: "folder-catalog-title" });
      const summary = node("p","",{ id: "folder-catalog-summary" });
      const helper = node("p","",{ id: "folder-catalog-helper" });
      const error = node("p","",{ role: "alert", class: "folder-catalog-alert" }); error.hidden = true;
      const content = node("div","",{ class: "folder-catalog-content" });
      const cancel = node("button","Отмена",{ type: "button", class: "board-task-quiet", autofocus: "" });
      const confirm = node("button","",{ type: "button", class: mode === "remove" ? "task-delete-confirm" : "board-task-primary" });
      body.append(node("p",mode === "move" ? "Workspace" : "Папка воркспейсов",{ class: "eyebrow" }),heading,summary,helper,content,error);
      footer.append(cancel,confirm); dialog.append(body,footer); document.body.append(dialog);
      modal = { dialog, title: heading, summary, helper, content, error, cancel, confirm, mode, origin, busy: false, record: null };
      cancel.onclick = () => closeModal();
      dialog.addEventListener("cancel",event => { event.preventDefault(); closeModal(); });
      dialog.addEventListener("click",event => {
        const rect = dialog.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeModal();
      });
      dialog.showModal(); cancel.focus(); return modal;
    }
    function readyRemoval(preview) {
      if (!modal || !preview.folder) return;
      const current = modal; current.mode = "remove"; current.preview = preview;
      current.title.textContent = `Удалить папку «${preview.folder.name}»?`;
      current.summary.textContent = preview.members.length ? `Папка будет удалена. ${movement(preview.members.length)}` : "Папка пуста. Будет удалена только папка.";
      current.helper.textContent = "Воркспейсы, потоки, задачи, файлы и история сохранятся.";
      current.content.replaceChildren();
      if (preview.members.length) {
        const list = node("ul");
        for (const member of preview.members) list.append(node("li",member.name,{ title: member.name, "aria-label": member.name }));
        current.content.append(node("p",`Будут перемещены в «Без папки» — ${preview.members.length}`),list);
      }
      current.cancel.disabled = false; current.confirm.disabled = preview.childFolders !== 0;
      if (preview.childFolders !== 0) errorInModal("Структура папки не поддерживается. Удаление недоступно.");
      current.confirm.removeAttribute("aria-disabled");
      current.confirm.className = "task-delete-confirm"; current.confirm.textContent = "Удалить папку";
      current.confirm.onclick = () => {
        if (current.busy || current.confirm.disabled) return;
        void submit("remove",{ folderId: preview.folder.id, previewToken: preview.token },{
          folderId: preview.folder.id, folderName: preview.folder.name, keyboard: true,
          origin: current.origin, folderIndex: model.folders.findIndex(item => item.id === preview.folder.id),
        });
      };
    }
    async function openRemove(id,origin) {
      if (blocked({ folderId: id })) return;
      const folder = byId(id); if (!folder) return;
      const current = openShell("remove",`Удалить папку «${folder.name}»?`,origin); if (!current) return;
      current.summary.textContent = "Проверяем содержимое папки…";
      current.summary.setAttribute("role","status"); current.summary.setAttribute("aria-live","polite"); current.summary.setAttribute("aria-atomic","true");
      current.confirm.textContent = "Удалить папку"; current.confirm.disabled = true;
      const preview = async () => {
        try {
          current.confirm.disabled = true;
          const value = await read("workspace-folder-preview",{ folderId: id });
          if (modal !== current) return;
          if (value.absent) {
            transport.applySnapshot(await read("snapshot",{}));
            if (byId(id)) throw new Error("Отсутствие папки пока не подтверждено snapshot.");
            current.title.textContent = "Папка уже удалена в другом окне."; current.summary.textContent = "";
            current.confirm.hidden = true; current.cancel.textContent = "Закрыть";
          } else { current.error.hidden = true; readyRemoval(value); }
        } catch {
          if (modal !== current) return;
          current.summary.textContent = "";
          errorInModal("Не удалось проверить содержимое папки.");
          current.confirm.className = "board-task-primary"; current.confirm.textContent = "Проверить снова";
          current.confirm.disabled = false; current.confirm.onclick = () => void preview();
        }
      };
      await preview();
    }
    function openMove(id,origin) {
      if (!model || blocked({ workspaceId: id })) return;
      const source = workspace(id); if (!source || source.kind === "system") return;
      const initialSource = byName(source.settings?.catalogFolder)?.id ?? null;
      const current = openShell("move","Переместить Workspace",origin); if (!current) return;
      current.summary.textContent = source.name;
      const label = node("label","Папка",{ for: "folder-catalog-target" });
      const select = node("select","",{ id: "folder-catalog-target", "aria-label": "Папка" });
      select.append(node("option","Без папки",{ value: "" }));
      const choices = new Map(model.folders.map(folder => [folder.id,{ ...folder }]));
      for (const folder of choices.values()) select.append(node("option",folder.name,{ value: folder.id, title: folder.name }));
      select.value = initialSource || ""; current.content.append(label,select);
      current.confirm.textContent = "Переместить"; current.confirm.disabled = true;
      select.onchange = () => { current.confirm.disabled = select.value === (initialSource || ""); };
      current.confirm.onclick = () => {
        if (current.busy || current.confirm.disabled) return;
        const destination = choices.get(select.value) ?? null;
        void submit("move",{ workspaceId: id, sourceFolderId: initialSource,
          target: destination ? { id: destination.id, revision: destination.revision } : null },{
          workspaceId: id, workspaceName: source.name, targetName: destination?.name ?? "", targetId: destination?.id ?? null,
          origin, keyboard: true,
        });
      };
    }
    function validTarget(event) {
      if (!drag || !event.dataTransfer?.types.includes(MIME)) return null;
      const row = event.target.closest(".task-workspace-folder-summary");
      if (!row || event.target.closest("button")) return null;
      const folder = byName(row.closest("[data-workspace-folder-name]")?.dataset.workspaceFolderName);
      if (!folder || folder.id === drag.sourceFolderId || blocked({ folderId: folder.id })) return null;
      return { row, folder };
    }
    rail.addEventListener("dragstart",event => {
      const row = event.target.closest(".task-workspace-item[data-workspace-select]");
      if (!row) return;
      if (!row.draggable || event.target.closest("button,input,select,[data-mobile-workspace-edit]")) { event.preventDefault(); return; }
      const source = workspace(row.dataset.workspaceSelect); if (!source) { event.preventDefault(); return; }
      clearDrag(); drag = { nonce: crypto.randomUUID(), workspaceId: source.id, workspaceName: source.name,
        sourceFolderId: byName(source.settings?.catalogFolder)?.id ?? null };
      event.dataTransfer.setData(MIME,drag.nonce); event.dataTransfer.effectAllowed = "move";
      row.setAttribute("data-folder-drag-source","");
    });
    rail.addEventListener("dragover",event => {
      rail.querySelectorAll("[data-folder-drop-target]").forEach(row => row.removeAttribute("data-folder-drop-target"));
      const target = validTarget(event);
      if (!target) { if (drag) event.dataTransfer.dropEffect = "none"; return; }
      event.preventDefault(); event.dataTransfer.dropEffect = "move"; target.row.setAttribute("data-folder-drop-target","");
    });
    rail.addEventListener("drop",event => {
      const target = validTarget(event), source = drag;
      if (!target || event.dataTransfer.getData(MIME) !== source?.nonce) { clearDrag(); return; }
      event.preventDefault();
      const collapsed = !target.row.parentElement.open;
      if (collapsed) heldClosed.add(target.folder.id);
      persistClosed();
      clearDrag();
      void submit("move",{ workspaceId: source.workspaceId, sourceFolderId: source.sourceFolderId,
        target: { id: target.folder.id, revision: target.folder.revision } },{
          workspaceId: source.workspaceId, workspaceName: source.workspaceName, targetId: target.folder.id,
          targetName: target.folder.name, keyboard: false,
        });
    });
    rail.addEventListener("dragend",clearDrag);
    document.addEventListener("dragover",event => {
      if (drag && !rail.contains(event.target)) rail.querySelectorAll("[data-folder-drop-target]")
        .forEach(row => row.removeAttribute("data-folder-drop-target"));
    });
    rail.addEventListener("toggle",event => {
      const folder = byName(event.target.closest("[data-workspace-folder-name]")?.dataset.workspaceFolderName);
      if (folder && event.isTrusted && event.target.open) { heldClosed.delete(folder.id); persistClosed(); }
    },true);
    updateNotices();
    return {
      configure(value) { transport = value; },
      beforeRender() {
        const active = document.activeElement;
        const row = active?.closest?.("[data-workspace-select], [data-workspace-folder-name]");
        return { active, workspaceId: row?.dataset.workspaceSelect, folderId: row?.dataset.workspaceFolderId,
          inRail: rail.contains(active), scrollTop: rail.scrollTop, parentScrollTop: rail.parentElement.scrollTop };
      },
      afterRender(saved) {
        if (!saved) return;
        rail.scrollTop = saved.scrollTop; rail.parentElement.scrollTop = saved.parentScrollTop;
        if (!saved.inRail || document.activeElement === saved.active
          || document.activeElement !== document.body && document.activeElement?.isConnected) return;
        const rows = saved.workspaceId ? [...rail.querySelectorAll("[data-workspace-select]")]
          : [...rail.querySelectorAll("[data-workspace-folder-name]")];
        const row = rows.find(item => saved.workspaceId ? item.dataset.workspaceSelect === saved.workspaceId
          : item.dataset.workspaceFolderId === saved.folderId);
        const target = (saved.active?.isConnected ? saved.active : null)
          || row?.querySelector(saved.workspaceId ? "[data-mobile-workspace-select]" : "summary") || row
          || rail.querySelector("summary,[tabindex],button");
        target?.focus({ preventScroll: true });
      },
      setCatalog(value) {
        if (!value || value.version !== 1 || !Array.isArray(value.folders)) return false;
        const changed = model?.revision !== value.revision;
        if (changed) {
          clearDrag();
          const ids = new Set(value.folders.map(folder=>folder.id));
          for (const id of heldClosed) if (!ids.has(id)) heldClosed.delete(id);
          persistClosed();
        }
        model = value; decorate(); return changed;
      },
      get ready() { return Boolean(model && transport); },
      get revision() { return model?.revision ?? null; },
      names: () => model?.folders.map(folder => folder.name) ?? null,
      folders: () => model?.folders ?? [],
      folder: byName, folderById: byId, blocked, decorate, openRemove, openMove,
      hasPendingAction: action => [...operations.values()].some(record => record.input.action === action),
      keepClosed: name => heldClosed.has(byName(name)?.id),
      async createFolder(name) { return submit("create",{ name },{ folderName: name }); },
      async renameFolder(folder,name,origin) { return submit("rename",{ folderId: folder.id, expectedRevision: folder.revision, name },{ folderId: folder.id, folderName: folder.name, origin, keyboard: true }); },
      async importLegacy(names) { return submit("import",{ names },{}); },
      submit, clearDrag,
    };
  }
  window.AgentHubWorkspaceFolders = Object.freeze({ create });
})();
