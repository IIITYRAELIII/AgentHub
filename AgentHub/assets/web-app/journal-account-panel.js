(() => {
  "use strict";

  const RANGE_SEQUENCE = Object.freeze(["today", "24h", "7d", "15d", "30d", "all"]);
  const RANGE_SET = new Set(RANGE_SEQUENCE);
  const RANGE_STORAGE_KEY = "agent-hub:journal-account-range:v1";
  const DEVICES_STORAGE_KEY = "agent-hub:journal-account-devices:v1";
  const AMOUNT_PATTERN = /^(.*?)\s+([GMk]?(?:ПТЭ|cr))$/u;
  const PANEL_SELECTOR = "[data-work-log-account-panel]";

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

  function normalizeAccountKeys(value) {
    return [...new Set((Array.isArray(value) ? value : [])
      .map((key) => String(key ?? ""))
      .filter(Boolean))];
  }

  function storedExpandedAccounts(storage) {
    try {
      const raw = storage?.getItem(DEVICES_STORAGE_KEY);
      return normalizeAccountKeys(raw ? JSON.parse(raw) : []);
    } catch {
      return [];
    }
  }

  function persistExpandedAccounts(storage, keys) {
    const list = normalizeAccountKeys(keys);
    try {
      storage?.setItem(DEVICES_STORAGE_KEY, JSON.stringify(list));
    } catch {
      // Раскрытые аккаунты останутся раскрытыми до закрытия WebView.
    }
    return list;
  }

  function toggleExpandedAccount(current, accountKey) {
    const key = String(accountKey ?? "");
    const list = normalizeAccountKeys(current);
    if (!key) return list;
    return list.includes(key) ? list.filter((value) => value !== key) : [...list, key];
  }

  function allAccountsExpanded(current, accountKeys) {
    const keys = normalizeAccountKeys(accountKeys);
    const list = normalizeAccountKeys(current);
    return keys.length > 0 && keys.every((key) => list.includes(key));
  }

  /* Кнопка в шапке — один переключатель: пока раскрыт не каждый аккаунт
     периода, она раскрывает все, и только после этого сворачивает. */
  function toggleAllAccounts(current, accountKeys) {
    const keys = normalizeAccountKeys(accountKeys);
    const list = normalizeAccountKeys(current);
    if (allAccountsExpanded(list, keys)) return list.filter((key) => !keys.includes(key));
    return normalizeAccountKeys([...list, ...keys]);
  }

  function devicesToggleLabel(current, accountKeys) {
    return allAccountsExpanded(current, accountKeys) ? "Свернуть устройства" : "Показать устройства";
  }

  /* Панель живёт в разметке журнала, но монтируется на страницу Статистики
     переносом узла, поэтому между рендерами в журнале её нет. Если она там
     всё-таки есть — это только что пришедшая проекция, и она новее уже
     смонтированной. Обратный порядок опроса сохранял бы смонтированную копию и
     терял обновление расхода после каждой синхронизации, поэтому сам порядок
     живёт здесь, а не в месте вызова. */
  function freshAccountPanelSource(journalRoot, mountedRoot) {
    return journalRoot?.querySelector(`:scope > ${PANEL_SELECTOR}`)
      ?? mountedRoot?.querySelector(PANEL_SELECTOR)
      ?? null;
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
    DEVICES_STORAGE_KEY,
    PANEL_SELECTOR,
    RANGE_SEQUENCE,
    RANGE_STORAGE_KEY,
    allAccountsExpanded,
    devicesToggleLabel,
    freshAccountPanelSource,
    normalizeRange,
    persistExpandedAccounts,
    persistRange,
    splitUsageAmount,
    storedExpandedAccounts,
    storedRange,
    toggleAllAccounts,
    toggleExpandedAccount,
  });
})();
