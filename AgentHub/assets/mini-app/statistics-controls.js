(() => {
  "use strict";

  const RANGE_SEQUENCE = Object.freeze(["6h", "24h", "7d", "15d", "30d", "all"]);

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

  window.AgentHubStatisticsControls = Object.freeze({
    RANGE_SEQUENCE,
    bindDatasetChoice,
    normalizeRange,
    persistRange,
    storedRange,
  });
})();
