(() => {
  "use strict";

  const RANGE_SEQUENCE = Object.freeze(["6h", "24h", "7d", "15d", "30d", "all"]);
  const LIMITS_RANGE_STORAGE_KEY = "agent-hub:limits-range:v1";

  function normalizeRange(value) {
    return RANGE_SEQUENCE.includes(String(value)) ? String(value) : "24h";
  }

  function storedRange(storage, key) {
    try {
      return normalizeRange(storage?.getItem(key));
    } catch {
      return "24h";
    }
  }

  function persistRange(storage, key, value) {
    const selected = normalizeRange(value);
    try {
      storage?.setItem(key, selected);
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
    return selected;
  }

  function storedLimitsRange(storage) {
    return storedRange(storage, LIMITS_RANGE_STORAGE_KEY);
  }

  function persistLimitsRange(storage, value) {
    return persistRange(storage, LIMITS_RANGE_STORAGE_KEY, value);
  }

  function payloadMatchesSelectedRange(payload, selectedRange) {
    return !payload?.range || normalizeRange(payload.range) === normalizeRange(selectedRange);
  }

  function resolveStatisticsAccountSelection({
    availableAccountKeys,
    selectedAccountKey,
    currentAccountKey,
    previousCurrentAccountKey,
    allAccountsKey = "all",
  } = {}) {
    const available = [...new Set((availableAccountKeys ?? []).map((key) => String(key)).filter(Boolean))];
    const selected = String(selectedAccountKey ?? "");
    const current = String(currentAccountKey ?? "");
    const previousCurrent = String(previousCurrentAccountKey ?? "");
    if (!available.length) return selected;
    const currentAvailable = current && available.includes(current);
    if (currentAvailable && (!previousCurrent || (
      current !== previousCurrent && selected === previousCurrent
    ))) return current;
    if (selected === allAccountsKey || available.includes(selected)) return selected;
    return currentAvailable ? current : available[0];
  }

  function bindDatasetChoice(buttons, datasetKey, select) {
    const listeners = [];
    for (const button of buttons ?? []) {
      const listener = () => select?.(button?.dataset?.[datasetKey]);
      button?.addEventListener?.("click", listener);
      listeners.push([button, listener]);
    }
    return () => {
      for (const [button, listener] of listeners) {
        button?.removeEventListener?.("click", listener);
      }
    };
  }

  const PAGE_SEQUENCE = Object.freeze(["usage", "limits", "comparison"]);
  const PAGE_STORAGE_KEY = "agent-hub:statistics-page:v1";

  function normalizeStatisticsPage(value) {
    return PAGE_SEQUENCE.includes(String(value)) ? String(value) : PAGE_SEQUENCE[0];
  }

  function storedStatisticsPage(storage) {
    try {
      return normalizeStatisticsPage(storage?.getItem(PAGE_STORAGE_KEY));
    } catch {
      return PAGE_SEQUENCE[0];
    }
  }

  function persistStatisticsPage(storage, value) {
    const page = normalizeStatisticsPage(value);
    try {
      storage?.setItem(PAGE_STORAGE_KEY, page);
    } catch {
      // Выбранная страница останется активной до закрытия WebView.
    }
    return page;
  }

  window.AgentHubStatisticsControls = Object.freeze({
    LIMITS_RANGE_STORAGE_KEY,
    PAGE_SEQUENCE,
    PAGE_STORAGE_KEY,
    RANGE_SEQUENCE,
    bindDatasetChoice,
    normalizeRange,
    normalizeStatisticsPage,
    payloadMatchesSelectedRange,
    persistLimitsRange,
    persistRange,
    persistStatisticsPage,
    resolveStatisticsAccountSelection,
    storedLimitsRange,
    storedRange,
    storedStatisticsPage,
  });

  /* Переключение страниц графиков. Скрытая страница остаётся в рамке абсолютом
     и сохраняет ширину, поэтому перерисовывать SVG при переключении не нужно.
     Модуль читается и тестами в Node, где документа нет. */
  if (typeof document === "undefined") return;

  function bindStatisticsPager() {
    const pager = document.querySelector("[data-statistics-pager]");
    const pages = [...document.querySelectorAll("[data-statistics-page]")];
    if (!pager || !pages.length) return;
    const tabs = [...pager.querySelectorAll("[data-statistics-page-button]")];

    function activate(value, persist = true) {
      const page = normalizeStatisticsPage(value);
      for (const section of pages) {
        section.classList.toggle("is-active", section.dataset.statisticsPage === page);
      }
      for (const tab of tabs) {
        tab.setAttribute(
          "aria-selected",
          String(tab.dataset.statisticsPageButton === page),
        );
      }
      if (persist) persistStatisticsPage(window.localStorage, page);
    }

    for (const tab of tabs) {
      tab.addEventListener("click", () => activate(tab.dataset.statisticsPageButton));
    }
    pager.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
      const next = tabs[(current + step + tabs.length) % tabs.length];
      next?.focus();
      activate(next?.dataset.statisticsPageButton);
    });
    activate(storedStatisticsPage(window.localStorage), false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindStatisticsPager, { once: true });
  } else {
    bindStatisticsPager();
  }
})();
