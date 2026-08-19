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

  window.AgentHubStatisticsControls = Object.freeze({
    LIMITS_RANGE_STORAGE_KEY,
    RANGE_SEQUENCE,
    bindDatasetChoice,
    normalizeRange,
    payloadMatchesSelectedRange,
    persistLimitsRange,
    persistRange,
    resolveStatisticsAccountSelection,
    storedLimitsRange,
    storedRange,
  });
})();
