"use strict";

(() => {
  const requestId = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  };
  const formatBytes = (value) => {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} МБ`;
    return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  };
  const formatDate = (value) => new Intl.DateTimeFormat("ru", {
    dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value));
  const ttlLabel = (value) => {
    const hours = Number(value) / 3_600_000;
    if (hours < 24) return `${hours} ч`;
    const days = hours / 24;
    return `${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"}`;
  };

  let request = null;
  let currentPath = "";
  let opener = null;
  let snapshot = null;
  let selectedTtl = null;
  let pendingCreateRequestId = "";
  let pollTimer = null;
  const knownShares = new Map();

  const dialog = document.createElement("dialog");
  dialog.className = "file-transfer-owner-dialog";
  dialog.setAttribute("aria-labelledby", "file-transfer-owner-title");
  dialog.setAttribute("aria-describedby", "file-transfer-owner-body");
  dialog.innerHTML = `
    <form method="dialog" class="file-transfer-owner-panel">
      <header>
        <div>
          <p class="file-transfer-owner-kicker">Внешняя передача</p>
          <h2 id="file-transfer-owner-title" tabindex="-1">Защищённая внешняя ссылка</h2>
        </div>
        <button type="submit" class="file-transfer-owner-close" value="cancel" aria-label="Закрыть">×</button>
      </header>
      <div id="file-transfer-owner-body" class="file-transfer-owner-body" aria-live="polite"></div>
      <footer class="file-transfer-owner-actions"></footer>
    </form>`;
  document.body.append(dialog);
  const body = dialog.querySelector(".file-transfer-owner-body");
  const actions = dialog.querySelector(".file-transfer-owner-actions");

  const revokeDialog = document.createElement("dialog");
  revokeDialog.className = "file-transfer-revoke-dialog";
  revokeDialog.setAttribute("aria-labelledby", "file-transfer-revoke-title");
  revokeDialog.innerHTML = `
    <form method="dialog">
      <h2 id="file-transfer-revoke-title">Отозвать ссылку?</h2>
      <p>Новые байты больше не будут передаваться. Возобновить эту ссылку будет нельзя.</p>
      <div class="file-transfer-owner-actions">
        <button type="submit" value="cancel">Отмена</button>
        <button type="button" class="danger" data-transfer-confirm-revoke>Отозвать</button>
      </div>
    </form>`;
  document.body.append(revokeDialog);

  const button = (label, handler, className = "") => {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.className = className;
    control.addEventListener("click", handler);
    return control;
  };
  const setActions = (...controls) => actions.replaceChildren(...controls.filter(Boolean));
  const fileSummary = (file = snapshot?.file) => `
    <div class="file-transfer-owner-file">
      <strong title="${escapeHtml(file?.name)}">${escapeHtml(file?.name || "Файл")}</strong>
      <span>${formatBytes(file?.size)}</span>
    </div>`;
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/gu, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[char]);
  }
  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }
  function schedulePoll() {
    stopPolling();
    if (dialog.open) pollTimer = setTimeout(() => void refresh({ quiet: true }), 900);
  }
  function renderCreate() {
    const options = snapshot.ttlOptions || [];
    if (!options.includes(selectedTtl)) selectedTtl = options[0] ?? null;
    body.innerHTML = `${fileSummary()}
      <label class="file-transfer-owner-field"><span>Срок действия</span>
        <select data-transfer-ttl>${options.map((ttl) => `<option value="${ttl}"${ttl === selectedTtl ? " selected" : ""}>${ttlLabel(ttl)}</option>`).join("")}</select>
      </label>
      <p class="file-transfer-owner-warning">Первый получатель, который нажмёт „Скачать“, закрепит ссылку за этим браузером. После этого другой браузер использовать ссылку не сможет.</p>
      <p class="file-transfer-owner-helper">Продолжение возможно только в том же браузере, пока доступен локальный защищённый ключ и не истёк срок сессии.</p>`;
    body.querySelector("[data-transfer-ttl]")?.addEventListener("change", (event) => {
      selectedTtl = Number(event.target.value);
    });
    setActions(button("Отмена", () => dialog.close()), button("Создать ссылку", () => void create(), "primary"));
  }
  function renderPreparing(artifact) {
    const processed = Number(artifact?.preparedBytes) || 0;
    const total = Number(snapshot.file?.size) || Number(artifact?.size) || 0;
    const determinate = total > 0 && processed >= 0;
    body.innerHTML = `${fileSummary()}
      <section class="file-transfer-owner-state" aria-labelledby="file-transfer-owner-state-title">
        <h3 id="file-transfer-owner-state-title">Подготовка файла</h3>
        <p>Создаём неизменяемую копию и вычисляем SHA-256.</p>
        <div class="file-transfer-owner-progress" role="progressbar"${determinate ? ` aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${Math.min(processed, total)}"` : ""}>
          <span style="--progress:${determinate ? Math.min(100, processed / total * 100) : 35}%"></span>
        </div>
        <p class="file-transfer-owner-helper">${determinate ? `${formatBytes(processed)} из ${formatBytes(total)}. ` : ""}Можно закрыть окно: подготовка сохранится на сервере.</p>
      </section>`;
    setActions(button("Закрыть", () => dialog.close()));
    schedulePoll();
  }
  function renderReady(share) {
    body.innerHTML = `${fileSummary()}
      <section class="file-transfer-owner-state" aria-labelledby="file-transfer-owner-state-title">
        <h3 id="file-transfer-owner-state-title">Ссылка готова</h3>
        <label class="file-transfer-owner-field"><span>Внешняя ссылка</span>
          <input type="text" readonly value="${escapeHtml(share.url)}" data-transfer-url>
        </label>
        <p class="file-transfer-copy-status" data-transfer-copy-status aria-live="polite"></p>
        <dl class="file-transfer-owner-details">
          <div><dt>Доступна до</dt><dd>${formatDate(share.expiresAt)}</dd></div>
          <div><dt>Размер</dt><dd>${formatBytes(share.size)}</dd></div>
          <div><dt>SHA-256</dt><dd><code>${escapeHtml(share.sha256 || "—")}</code></dd></div>
        </dl>
      </section>`;
    const copy = button("Копировать ссылку", async () => {
      const status = body.querySelector("[data-transfer-copy-status]");
      try {
        await navigator.clipboard.writeText(share.url);
        status.textContent = "Ссылка скопирована";
      } catch {
        body.querySelector("[data-transfer-url]")?.select();
        status.textContent = "Не удалось скопировать ссылку. Поле оставлено выделенным.";
      }
    }, "primary");
    setActions(copy, button("Отозвать ссылку", () => revokeDialog.showModal(), "danger"));
  }
  function renderShare(share) {
    const states = {
      claimed: ["Ссылка использована", "Защищённая загрузка закреплена за браузером получателя."],
      downloading: ["Файл передаётся", `${formatBytes(share.bytesServed)} из ${formatBytes(share.size)}`],
      completed: ["Передача завершена", "Сервер передал файл целиком. Это не подтверждает, что файл сохранён получателем."],
      expired: ["Срок ссылки истёк", "Ссылка больше недоступна."],
      revoked: ["Ссылка отозвана", "Передача по этой ссылке прекращена."],
      failed: ["Ошибка передачи", "Не удалось безопасно продолжить передачу."],
      ambiguous_terminal: ["Ошибка передачи", "Результат передачи неоднозначен. Ссылка закрыта без возможности возобновления."],
      revoking: ["Отзываем ссылку", "Новые блоки больше не будут разрешены."],
      expiring: ["Срок истёк", "Ссылка закрывается."],
    };
    const [heading, copy] = states[share.state] || ["Статус ссылки", "Получаем актуальное состояние."];
    const progress = share.state === "downloading" ? `
      <div class="file-transfer-owner-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${share.size}" aria-valuenow="${share.bytesServed}">
        <span style="--progress:${Math.min(100, share.bytesServed / share.size * 100)}%"></span>
      </div>` : "";
    const claimed = share.claimedAt ? `<p class="file-transfer-owner-helper">Начало: ${formatDate(share.claimedAt)}</p>` : "";
    body.innerHTML = `${fileSummary()}
      <section class="file-transfer-owner-state" aria-labelledby="file-transfer-owner-state-title">
        <h3 id="file-transfer-owner-state-title">${escapeHtml(heading)}</h3>
        <p>${escapeHtml(copy)}</p>${progress}${claimed}
      </section>`;
    const terminal = ["completed", "expired", "revoked", "failed", "ambiguous_terminal"].includes(share.state);
    setActions(
      terminal ? button("Создать новую ссылку", renderCreate, "primary") : null,
      ["claimed", "downloading"].includes(share.state) ? button("Отозвать ссылку", () => revokeDialog.showModal(), "danger") : null,
      button("Закрыть", () => dialog.close()),
    );
    if (["claimed", "downloading", "revoking", "expiring"].includes(share.state)) schedulePoll();
  }
  function renderUnknown() {
    body.innerHTML = `${fileSummary(snapshot?.file)}<section role="alert" class="file-transfer-owner-state file-transfer-owner-error" aria-labelledby="file-transfer-owner-state-title">
      <h3 id="file-transfer-owner-state-title">Не удалось получить актуальный статус</h3>
      <p>Не создавайте новую ссылку, пока статус не обновится.</p>
    </section>`;
    setActions(button("Обновить статус", () => void refresh(), "primary"), button("Закрыть", () => dialog.close()));
  }
  function render() {
    stopPolling();
    const { artifact, share } = snapshot;
    if (share?.state === "ready" && share.url) renderReady(share);
    else if (share) renderShare(share);
    else if (["preparing", "publishing"].includes(artifact?.state)) renderPreparing(artifact);
    else renderCreate();
  }
  async function refresh({ quiet = false } = {}) {
    try {
      snapshot = await request("status", { path: currentPath });
      knownShares.set(currentPath, Boolean(snapshot.share));
      if (pendingCreateRequestId && snapshot.artifact?.state === "ready" && !snapshot.share) {
        const created = await request("create", {
          artifactId: snapshot.artifact.id, requestId: pendingCreateRequestId, ttlMs: selectedTtl,
        });
        pendingCreateRequestId = "";
        snapshot.share = created.share;
      }
      render();
    } catch {
      if (!quiet || dialog.open) renderUnknown();
    }
  }
  async function create() {
    if (!selectedTtl) return;
    setActions();
    const priorArtifact = snapshot.artifact?.state === "ready" ? snapshot.artifact : null;
    try {
      if (!priorArtifact) {
        pendingCreateRequestId = requestId();
        const prepared = await request("prepare", { path: currentPath, requestId: requestId() });
        snapshot.artifact = prepared.artifact;
        renderPreparing(snapshot.artifact);
        return;
      }
      const created = await request("create", {
        artifactId: priorArtifact.id, requestId: pendingCreateRequestId || requestId(), ttlMs: selectedTtl,
      });
      pendingCreateRequestId = "";
      snapshot.share = created.share;
      render();
    } catch { await refresh(); }
  }
  async function revoke() {
    const control = revokeDialog.querySelector("[data-transfer-confirm-revoke]");
    control.disabled = true;
    try {
      await request("revoke", { shareId: snapshot.share.id });
      revokeDialog.close();
      await refresh();
    } catch {
      revokeDialog.close();
      renderUnknown();
    } finally { control.disabled = false; }
  }
  revokeDialog.querySelector("[data-transfer-confirm-revoke]").addEventListener("click", () => void revoke());
  dialog.addEventListener("close", () => {
    stopPolling();
    opener?.focus?.({ preventScroll: true });
    opener = null;
  });
  dialog.addEventListener("cancel", () => { if (revokeDialog.open) revokeDialog.close(); });

  window.AgentHubFileTransferOwner = Object.freeze({
    configure(handler) { request = handler; },
    actionLabel(path) {
      return knownShares.get(String(path)) === true ? "Внешняя ссылка…" : "Создать внешнюю ссылку…";
    },
    async probe(path) {
      const target = String(path ?? "").trim();
      if (!request || !target) return "Создать внешнюю ссылку…";
      try {
        const value = await request("status", { path: target });
        knownShares.set(target, Boolean(value.share));
      } catch { /* Unknown status must not imply that a new link is safe. */ }
      return knownShares.get(target) === true ? "Внешняя ссылка…" : "Создать внешнюю ссылку…";
    },
    async open({ path, trigger }) {
      if (!request || !String(path ?? "").trim()) return;
      currentPath = String(path).trim();
      pendingCreateRequestId = "";
      opener = trigger instanceof HTMLElement ? trigger : document.activeElement;
      snapshot = { file: { name: currentPath.split(/[\\/]/u).at(-1) || "Файл", size: 0 }, artifact: null, share: null, ttlOptions: [] };
      body.innerHTML = `${fileSummary(snapshot.file)}<p role="status">Получаем актуальный статус…</p>`;
      setActions(button("Отмена", () => dialog.close()));
      dialog.showModal();
      dialog.querySelector("h2")?.focus?.();
      await refresh();
    },
  });
})();
