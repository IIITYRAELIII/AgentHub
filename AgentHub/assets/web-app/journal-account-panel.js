(() => {
  "use strict";

  const RANGE_SEQUENCE = Object.freeze(["today", "24h", "7d", "30d", "all"]);
  const RANGE_SET = new Set(RANGE_SEQUENCE);
  const RANGE_STORAGE_KEY = "agent-hub:journal-account-range:v1";
  const AMOUNT_PATTERN = /^(.*?)\s+([GMk]?(?:ПТЭ|cr))$/u;

  function availableRanges(available) {
    const list = [...(Array.isArray(available) ? available : RANGE_SEQUENCE)]
      .map((value) => String(value ?? ""))
      .filter((value) => RANGE_SET.has(value));
    return list.length ? list : [...RANGE_SEQUENCE];
  }

  function normalizeRange(value, available) {
    const list = availableRanges(available);
    const candidate = String(value ?? "");
    return list.includes(candidate) ? candidate : list[0];
  }

  function storedRange(storage, available) {
    try {
      return normalizeRange(storage?.getItem(RANGE_STORAGE_KEY), available);
    } catch {
      return normalizeRange("", available);
    }
  }

  function persistRange(storage, value, available) {
    const range = normalizeRange(value, available);
    try {
      storage?.setItem(RANGE_STORAGE_KEY, range);
    } catch {
      // Выбранный период останется активным до закрытия WebView.
    }
    return range;
  }

  /* Десктоп всегда держит ровно один раскрытый период, поэтому повторный клик
     по активной плитке ничего не сворачивает. На телефоне это аккордеон:
     повторный тап закрывает период и оставляет только ленту заголовков. */
  function nextPanelState(state, value, { mobile = false, available } = {}) {
    const range = normalizeRange(value, available);
    const current = normalizeRange(state?.range, available);
    const open = state?.open !== false;
    if (!mobile) return { range, open: true };
    if (current === range && open) return { range, open: false };
    return { range, open: true };
  }

  /* Плитка периода показывает число крупно, а единицу — мелко, поэтому
     форматированный расход разбирается на два самостоятельных фрагмента.
     Валютные единицы идут префиксом и остаются одним числом. */
  function splitUsageAmount(text) {
    const value = String(text ?? "").trim();
    const match = AMOUNT_PATTERN.exec(value);
    return match ? { amount: match[1], unit: match[2] } : { amount: value, unit: "" };
  }

  window.AgentHubJournalAccountPanel = Object.freeze({
    RANGE_SEQUENCE,
    RANGE_STORAGE_KEY,
    normalizeRange,
    nextPanelState,
    persistRange,
    splitUsageAmount,
    storedRange,
  });
})();
