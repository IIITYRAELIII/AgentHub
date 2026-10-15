(() => {
  "use strict";

  // Same client-profile boundary as chat-surface/activity-rail preferences.
  // This must never be included in shared runtime selection or snapshots.
  const STORAGE_KEY = "agent-hub:composer-shortcuts:v1";
  const DEFAULTS = Object.freeze({ enter: "queue", ctrlEnter: "newline", shiftEnter: "newline" });
  const ACTIONS = new Set(["queue", "steer", "newline"]);

  function normalize(value) {
    const result = {};
    for (const key of Object.keys(DEFAULTS)) result[key] = value && Object.hasOwn(value, key) && ACTIONS.has(value[key])
      ? value[key] : DEFAULTS[key];
    return result;
  }
  function isDefault(value) {
    const mapping = normalize(value);
    return Object.keys(DEFAULTS).every((key) => mapping[key] === DEFAULTS[key]);
  }
  function resolveStorage(storage) { return typeof storage === "function" ? storage() : storage; }
  function stored(storage) {
    try {
      const value = JSON.parse(resolveStorage(storage)?.getItem(STORAGE_KEY) ?? "null");
      if (!value || typeof value !== "object" || Array.isArray(value)) return { mapping: normalize(null), configured: false };
      return { mapping: normalize(value), configured: true };
    } catch { return { mapping: normalize(null), configured: false }; }
  }
  function persist(storage, mapping) {
    const value = normalize(mapping);
    try {
      const target = resolveStorage(storage);
      if (typeof target?.setItem !== "function") throw new Error("Storage unavailable");
      target.setItem(STORAGE_KEY, JSON.stringify(value));
      return { ok: true, mapping: value };
    } catch { return { ok: false }; }
  }
  function chord(event) {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.metaKey || event.altKey) return null;
    if (event.ctrlKey && event.shiftKey) return null;
    return event.ctrlKey ? "ctrlEnter" : event.shiftKey ? "shiftEnter" : "enter";
  }

  function createSettings({ document: doc, storage, overlays }) {
    const entry = doc.querySelector("[data-composer-shortcuts-open]");
    const modal = doc.querySelector("[data-composer-shortcuts-dialog]");
    const discard = doc.querySelector("[data-composer-shortcuts-discard]");
    const selects = [...modal.querySelectorAll("[data-composer-shortcut]")];
    const error = modal.querySelector("[data-composer-shortcuts-error]");
    const warning = modal.querySelector("[data-composer-shortcuts-warning]");
    let preference = stored(storage);
    let draft = normalize(preference.mapping);
    const phone = () => doc.documentElement.hasAttribute("data-phone-composer");
    // Mobile displays the effective bare Enter action, not the stored desktop
    // preference. Saving Ctrl/Shift must not overwrite that hidden preference.
    const readDraft = () => normalize({ ...draft, ...Object.fromEntries(selects.filter((select) => !select.disabled).map((select) => [select.dataset.composerShortcut, select.value])) });
    const renderEntry = () => { entry.querySelector("[data-composer-shortcuts-summary]").textContent = isDefault(preference.mapping) ? "Стандартные" : "Настроено"; };
    const updateWarning = () => {
      const mapping = readDraft();
      warning.hidden = phone() || Object.values(mapping).includes("newline");
      modal.querySelector("[data-composer-shortcuts-restore]").disabled = isDefault(mapping);
    };
    const renderDraft = () => {
      for (const select of selects) {
        select.disabled = phone() && select.dataset.composerShortcut === "enter";
        select.value = select.disabled ? "newline" : draft[select.dataset.composerShortcut];
      }
      updateWarning(); error.hidden = true;
    };
    const dirty = () => JSON.stringify(readDraft()) !== JSON.stringify(normalize(preference.mapping));
    const close = () => { modal.close(); entry.focus({ preventScroll: true }); };
    const requestClose = () => { if (dirty()) discard.showModal(); else close(); };
    entry.addEventListener("click", () => {
      draft = normalize(preference.mapping); renderDraft();
      doc.querySelector("[data-composer-shortcuts-saved]").textContent = "";
      modal.showModal(); selects.find((select) => !select.disabled).focus({ preventScroll: true });
    });
    for (const select of selects) select.addEventListener("change", () => { draft = readDraft(); updateWarning(); error.hidden = true; });
    modal.querySelector("[data-composer-shortcuts-restore]").addEventListener("click", () => { draft = normalize(null); renderDraft(); });
    modal.querySelectorAll("[data-composer-shortcuts-cancel]").forEach((button) => button.addEventListener("click", requestClose));
    modal.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const result = persist(storage, readDraft());
      if (!result.ok) { error.hidden = false; return; }
      preference = { mapping: result.mapping, configured: true }; renderEntry(); close();
      doc.querySelector("[data-composer-shortcuts-saved]").textContent = "Сочетания сохранены";
    });
    discard.querySelector("[data-composer-shortcuts-keep]").addEventListener("click", () => discard.close());
    discard.querySelector("[data-composer-shortcuts-discard-confirm]").addEventListener("click", () => { discard.close(); close(); });
    overlays.installDismissibleOverlay({ dialog: modal, close: requestClose, returnFocus: entry });
    overlays.installDismissibleOverlay({ dialog: discard, close: () => discard.close() });
    discard.addEventListener("close", () => { if (modal.open) overlays.activateOverlay(modal, entry); });
    renderEntry();
    new doc.defaultView.MutationObserver(() => { if (modal.open) { draft = readDraft(); renderDraft(); } })
      .observe(doc.documentElement, { attributes: true, attributeFilter: ["data-phone-composer"] });
    doc.defaultView.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      preference = stored(storage); renderEntry();
    });
    return {
      preference: () => ({ mapping: normalize(preference.mapping), configured: preference.configured }),
      handleBack: () => {
        if (discard.open) { discard.close(); return true; }
        if (modal.open) { requestClose(); return true; }
        return false;
      },
    };
  }
  window.AgentHubComposerShortcuts = Object.freeze({ STORAGE_KEY, DEFAULTS, normalize, isDefault, stored, persist, chord, createSettings });
})();
