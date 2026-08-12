"use strict";

(() => {
  const DEFAULT_MAXIMUM_BYTES = 128 * 1024;

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

  const editor = document.querySelector("[data-root-agents-editor]");
  const input = editor?.querySelector("[data-root-agents-input]");
  const save = editor?.querySelector("[data-root-agents-save]");
  const discard = editor?.querySelector("[data-root-agents-discard]");
  const status = editor?.querySelector("[data-root-agents-status]");
  let savedContent = "";
  let maximumBytes = DEFAULT_MAXIMUM_BYTES;
  let loaded = false;

  function render() {
    if (!input || !save || !discard || !status) return;
    const state = editorState({ content: input.value, savedContent, maximumBytes });
    save.disabled = input.disabled || state.saveDisabled;
    discard.disabled = input.disabled || !state.changed;
    status.textContent = state.tooLarge
      ? `Превышен лимит: ${state.bytes} / ${maximumBytes} байт`
      : `${state.bytes} / ${maximumBytes} байт${state.changed ? " · есть изменения" : ""}`;
    status.toggleAttribute("data-error", state.tooLarge);
  }

  function setLoading(loading) {
    if (!input || !status) return;
    input.disabled = loading;
    if (loading) status.textContent = "Загрузка…";
    else render();
  }

  function setDocument(documentValue = {}) {
    if (!input) return;
    savedContent = String(documentValue.content ?? "");
    maximumBytes = Math.max(1, Number(documentValue.maximumBytes) || DEFAULT_MAXIMUM_BYTES);
    input.value = savedContent;
    input.disabled = false;
    loaded = true;
    render();
  }

  function setError(message) {
    if (!input || !status) return;
    input.disabled = !loaded;
    status.textContent = String(message ?? "Не удалось загрузить AGENTS.md");
    status.setAttribute("data-error", "");
  }

  editor?.addEventListener("toggle", () => {
    if (!editor.open || loaded) return;
    setLoading(true);
    dispatch("agenthub:root-agents-read");
  });
  input?.addEventListener("input", render);
  discard?.addEventListener("click", () => {
    input.value = savedContent;
    render();
  });
  save?.addEventListener("click", () => {
    const state = editorState({ content: input.value, savedContent, maximumBytes });
    if (state.saveDisabled) return render();
    setLoading(true);
    dispatch("agenthub:root-agents-update", { content: input.value });
  });

  window.AgentHubRootAgentsEditor = {
    DEFAULT_MAXIMUM_BYTES,
    editorState,
    setDocument,
    setError,
    setLoading,
    utf8Bytes,
  };
})();
