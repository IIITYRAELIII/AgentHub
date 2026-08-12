"use strict";

(() => {
  const DEFAULT_MAXIMUM_BYTES = 32 * 1024;

  function utf8Bytes(value, TextEncoderImpl = TextEncoder) {
    return new TextEncoderImpl().encode(String(value ?? "")).byteLength;
  }

  function editorState({ content = "", savedContent = "", maximumBytes = DEFAULT_MAXIMUM_BYTES } = {}) {
    const bytes = utf8Bytes(content);
    const changed = content !== savedContent;
    return {
      bytes,
      changed,
      tooLarge: bytes > maximumBytes,
      saveDisabled: !changed || bytes > maximumBytes,
    };
  }

  function dispatch(type, detail = {}) {
    document.dispatchEvent(new CustomEvent(type, { detail }));
  }

  const guide = document.querySelector("[data-agent-hub-guide]");
  const guideInput = guide?.querySelector("[data-agent-hub-guide-input]");
  const guideStatus = guide?.querySelector("[data-agent-hub-guide-status]");
  const globalEditor = document.querySelector("[data-global-pre-turn-editor]");
  const globalInput = globalEditor?.querySelector("[data-global-pre-turn-input]");
  const globalSave = globalEditor?.querySelector("[data-global-pre-turn-save]");
  const globalDiscard = globalEditor?.querySelector("[data-global-pre-turn-discard]");
  const globalStatus = globalEditor?.querySelector("[data-global-pre-turn-status]");
  let savedContent = "";
  let maximumBytes = DEFAULT_MAXIMUM_BYTES;
  let loaded = false;
  let loading = false;

  function renderGlobal() {
    if (!globalInput || !globalSave || !globalDiscard || !globalStatus) return;
    const state = editorState({ content: globalInput.value, savedContent, maximumBytes });
    globalSave.disabled = globalInput.disabled || state.saveDisabled;
    globalDiscard.disabled = globalInput.disabled || !state.changed;
    globalStatus.textContent = state.tooLarge
      ? `Превышен лимит: ${state.bytes} / ${maximumBytes} байт`
      : `${state.bytes} / ${maximumBytes} байт${state.changed ? " · есть изменения" : ""}`;
    globalStatus.toggleAttribute("data-error", state.tooLarge);
  }

  function setLoading(value) {
    loading = Boolean(value);
    const isLoading = loading;
    if (guideInput) guideInput.disabled = isLoading || !loaded;
    if (globalInput) globalInput.disabled = isLoading || !loaded;
    if (isLoading) {
      if (guideStatus) guideStatus.textContent = "Загрузка…";
      if (globalStatus) globalStatus.textContent = "Загрузка…";
    } else {
      renderGlobal();
    }
  }

  function setSnapshot(snapshot = {}) {
    loading = false;
    if (guideInput) {
      guideInput.value = String(snapshot.guide?.content ?? "");
      guideInput.disabled = false;
      guideInput.readOnly = true;
    }
    if (guideStatus) {
      guideStatus.textContent = `Только чтение · ${Number(snapshot.guide?.bytes) || 0} байт`;
      guideStatus.removeAttribute("data-error");
    }
    if (globalInput) {
      savedContent = String(snapshot.global?.content ?? "");
      maximumBytes = Math.max(1, Number(snapshot.global?.maximumBytes) || DEFAULT_MAXIMUM_BYTES);
      globalInput.value = savedContent;
      globalInput.disabled = false;
    }
    loaded = true;
    renderGlobal();
  }

  function setGlobalDocument(documentValue = {}) {
    setSnapshot({
      guide: { content: guideInput?.value ?? "", bytes: utf8Bytes(guideInput?.value ?? "") },
      global: documentValue,
    });
  }

  function setError(message) {
    loading = false;
    const text = String(message ?? "Не удалось загрузить инструкции");
    if (guideStatus) {
      guideStatus.textContent = text;
      guideStatus.setAttribute("data-error", "");
    }
    if (globalStatus) {
      globalStatus.textContent = text;
      globalStatus.setAttribute("data-error", "");
    }
    if (guideInput) guideInput.disabled = !loaded;
    if (globalInput) globalInput.disabled = !loaded;
  }

  function requestSnapshot() {
    if (loaded || loading) return;
    setLoading(true);
    dispatch("agenthub:pre-turn-instructions-read");
  }

  guide?.addEventListener("toggle", () => { if (guide.open) requestSnapshot(); });
  globalEditor?.addEventListener("toggle", () => { if (globalEditor.open) requestSnapshot(); });
  globalInput?.addEventListener("input", renderGlobal);
  globalDiscard?.addEventListener("click", () => {
    globalInput.value = savedContent;
    renderGlobal();
  });
  globalSave?.addEventListener("click", () => {
    const state = editorState({ content: globalInput.value, savedContent, maximumBytes });
    if (state.saveDisabled) return renderGlobal();
    setLoading(true);
    dispatch("agenthub:global-pre-turn-update", { content: globalInput.value });
  });

  window.AgentHubPreTurnInstructionsEditor = {
    DEFAULT_MAXIMUM_BYTES,
    editorState,
    setError,
    setGlobalDocument,
    setLoading,
    setSnapshot,
    utf8Bytes,
  };
})();
