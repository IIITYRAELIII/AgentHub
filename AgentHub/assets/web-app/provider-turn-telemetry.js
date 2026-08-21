(() => {
  "use strict";

  function timestampMs(value) {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function duration(value) {
    const milliseconds = Math.max(0, Number(value) || 0);
    if (milliseconds < 1_000) return `${Math.round(milliseconds)} мс`;
    const seconds = milliseconds / 1_000;
    if (seconds < 60) return `${seconds.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }

  function milestoneLabel(item) {
    const type = String(item?.type ?? "");
    const phase = String(item?.phase ?? "");
    if (type === "first-content") return "Первый текст от модели";
    if (type === "first-visible") return "Первый видимый ответ";
    if (type === "compaction-started") return "Началась свёртка контекста";
    if (type === "compaction-completed") return "Свёртка контекста завершена";
    if (type === "completed") return "Ход завершён";
    return ({
      starting: "Модель начала ход",
      reasoning: "Размышление",
      answering: "Формирование ответа",
      tool: "Работа инструмента",
      compaction: "Свёртка контекста",
      "waiting-user": "Ожидание пользователя",
      completed: "Ход завершён",
    })[phase] ?? String((item?.method ?? phase) || "Событие провайдера");
  }

  function derivedTimeline(providerStart, measurement) {
    const baseline = timestampMs(providerStart?.turnStartedAtMs)
      ?? timestampMs(providerStart?.acceptedAt)
      ?? timestampMs(providerStart?.requestedAt);
    const source = Array.isArray(providerStart?.timeline) ? providerStart.timeline : [];
    const rows = source.map((item) => ({
      atMs: timestampMs(item.atMs),
      label: milestoneLabel(item),
      detail: String(item.method ?? "").trim(),
    }));
    if (!rows.length && baseline != null) {
      rows.push({ atMs: baseline, label: "Ход принят", detail: "" });
      if (measurement?.firstEventMs != null) {
        rows.push({ atMs: baseline + measurement.firstEventMs, label: "Первое событие модели", detail: "" });
      }
      if (measurement?.firstContentMs != null) {
        rows.push({ atMs: baseline + measurement.firstContentMs, label: "Первый текст от модели", detail: "" });
      }
      if (measurement?.firstVisibleMs != null) {
        rows.push({ atMs: baseline + measurement.firstVisibleMs, label: "Первый видимый ответ", detail: "" });
      }
    }
    return rows
      .filter((row) => row.atMs != null)
      .sort((left, right) => left.atMs - right.atMs)
      .map((row) => ({ ...row, elapsed: baseline == null ? null : Math.max(0, row.atMs - baseline) }));
  }

  function positionTooltip(indicator, tooltip) {
    if (!indicator || !tooltip || tooltip.hidden) return;
    const rect = indicator.getBoundingClientRect();
    const left = Math.min(window.innerWidth - tooltip.offsetWidth - 12, Math.max(12, rect.left));
    tooltip.style.left = `${left}px`;
    const top = Math.min(window.innerHeight - tooltip.offsetHeight - 12, rect.bottom + 8);
    tooltip.style.top = `${Math.max(12, top)}px`;
  }

  function createController({ indicator, tooltip, tooltipText, dialog, summary, metrics, timeline, close }) {
    if (!indicator || !tooltip || !dialog) return { update() {} };
    let current = null;
    let hideTimer = null;

    function renderDialog() {
      if (!current || !dialog.open) return;
      summary.textContent = current.title.split("\n")[0] || "История хода";
      metrics.replaceChildren(...current.title.split("\n").slice(1).map((line) => {
        const item = document.createElement("li");
        item.textContent = line;
        return item;
      }));
      const rows = derivedTimeline(current.providerStart, current.measurement);
      timeline.replaceChildren(...rows.map((row) => {
        const item = document.createElement("li");
        const elapsed = document.createElement("time");
        elapsed.textContent = row.elapsed == null ? "—" : `+${duration(row.elapsed)}`;
        const body = document.createElement("span");
        body.textContent = row.detail ? `${row.label} · ${row.detail}` : row.label;
        item.append(elapsed, body);
        return item;
      }));
      timeline.toggleAttribute("data-empty", rows.length === 0);
    }

    function showTooltip() {
      clearTimeout(hideTimer);
      if (!current) return;
      tooltip.hidden = false;
      requestAnimationFrame(() => {
        tooltip.dataset.visible = "true";
        positionTooltip(indicator, tooltip);
      });
    }

    function hideTooltip() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        tooltip.dataset.visible = "false";
        setTimeout(() => {
          if (tooltip.dataset.visible !== "true") tooltip.hidden = true;
        }, 140);
      }, 80);
    }

    function openDialog() {
      if (!current) return;
      tooltip.dataset.visible = "false";
      tooltip.hidden = true;
      if (!dialog.open) dialog.showModal();
      renderDialog();
      indicator.setAttribute("aria-expanded", "true");
    }

    function closeDialog() {
      if (dialog.open) dialog.close();
      indicator.setAttribute("aria-expanded", "false");
    }

    indicator.addEventListener("pointerenter", showTooltip);
    indicator.addEventListener("pointerleave", hideTooltip);
    indicator.addEventListener("focus", showTooltip);
    indicator.addEventListener("blur", hideTooltip);
    indicator.addEventListener("click", openDialog);
    close?.addEventListener("click", closeDialog);
    dialog.addEventListener("close", () => indicator.setAttribute("aria-expanded", "false"));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog();
    });
    window.addEventListener("resize", () => positionTooltip(indicator, tooltip));
    window.addEventListener("scroll", () => positionTooltip(indicator, tooltip), true);

    return {
      update(details) {
        current = details?.measurement ? details : null;
        if (!current) {
          tooltip.hidden = true;
          tooltip.dataset.visible = "false";
          closeDialog();
          return;
        }
        tooltipText.textContent = current.title;
        if (!tooltip.hidden) positionTooltip(indicator, tooltip);
        renderDialog();
      },
    };
  }

  window.AgentHubProviderTurnTelemetry = Object.freeze({ createController, derivedTimeline });
})();
