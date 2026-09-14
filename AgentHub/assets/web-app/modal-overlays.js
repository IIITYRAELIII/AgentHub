(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const MODAL_CLOSE_ICON_SELECTORS = Object.freeze([
    "[data-context-usage-modal] .icon-button[data-action='context-usage-close']",
    "[data-provider-turn-close]",
    "[data-task-card-close]",
    "[data-task-start-close]",
    "[data-workspace-card-close]",
    "[data-workspace-archive-close]",
  ]);
  const overlayEntries = new Map();
  const overlayStack = [];
  const documentSequenceStates = new WeakMap();

  function createSvgElement(documentRef, localName) {
    if (typeof documentRef?.createElementNS !== "function") return null;
    return documentRef.createElementNS(SVG_NS, localName);
  }

  function createPhosphorXIcon(documentRef) {
    const svg = createSvgElement(documentRef, "svg");
    if (!svg) return null;
    svg.setAttribute("data-phosphor-icon", "x");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("aria-hidden", "true");
    for (const [x1, y1, x2, y2] of [
      [200, 56, 56, 200],
      [200, 200, 56, 56],
    ]) {
      const line = createSvgElement(documentRef, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "currentColor");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-linejoin", "round");
      line.setAttribute("stroke-width", "16");
      svg.append(line);
    }
    return svg;
  }

  function installModalCloseIcons(documentRef) {
    if (typeof documentRef?.querySelectorAll !== "function") return [];
    const buttons = MODAL_CLOSE_ICON_SELECTORS
      .flatMap((selector) => [...documentRef.querySelectorAll(selector)]);
    for (const button of buttons) {
      const existing = button.querySelector?.('svg[data-phosphor-icon="x"]');
      if (existing) {
        button.replaceChildren?.(existing);
        continue;
      }
      const icon = createPhosphorXIcon(documentRef);
      if (icon) button.replaceChildren?.(icon);
    }
    return buttons;
  }

  function numericCoordinate(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function pointOutsideRect(event, rect) {
    const x = numericCoordinate(event?.clientX);
    const y = numericCoordinate(event?.clientY);
    if (x == null || y == null || !rect) return true;
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
  }

  function isDialogBackdropPointerDown(event, dialog, content = null) {
    if (!event || !dialog || event.target !== dialog) return false;
    const rectSource = content && typeof content.getBoundingClientRect === "function"
      ? content
      : dialog;
    const rect = typeof rectSource.getBoundingClientRect === "function"
      ? rectSource.getBoundingClientRect()
      : null;
    return pointOutsideRect(event, rect);
  }

  function isPrimaryPointerDown(event) {
    return event?.type === "pointerdown"
      && event.isPrimary !== false
      && Number(event.button ?? 0) === 0;
  }

  function consumeEvent(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
  }

  function pointerSequenceKey(event) {
    const pointerId = Number(event?.pointerId);
    if (!Number.isFinite(pointerId)) return "";
    return `${String(event?.pointerType ?? "mouse")}\0${pointerId}`;
  }

  function sequenceStateForDocument(documentRef) {
    let state = documentSequenceStates.get(documentRef);
    if (state) return state;
    state = { guards: new Map(), released: [] };
    const removeGuard = (key) => {
      state.guards.delete(key);
      state.released = state.released.filter((candidate) => candidate !== key);
    };
    documentRef.addEventListener("pointerdown", (event) => {
      const key = pointerSequenceKey(event);
      if (key) removeGuard(key);
    }, true);
    documentRef.addEventListener("pointerup", (event) => {
      const key = pointerSequenceKey(event);
      const guard = key ? state.guards.get(key) : null;
      if (!guard) return;
      consumeEvent(event);
      guard.released = true;
      if (!state.released.includes(key)) state.released.push(key);
    }, true);
    documentRef.addEventListener("pointercancel", (event) => {
      const key = pointerSequenceKey(event);
      if (!key || !state.guards.has(key)) return;
      consumeEvent(event);
      removeGuard(key);
    }, true);
    documentRef.addEventListener("click", (event) => {
      if (Number(event?.detail ?? 0) === 0) return;
      const exactKey = pointerSequenceKey(event);
      if (exactKey && !state.guards.get(exactKey)?.released) return;
      const key = exactKey || state.released[0];
      if (!key) return;
      consumeEvent(event);
      removeGuard(key);
    }, true);
    documentSequenceStates.set(documentRef, state);
    return state;
  }

  function installCompatibilityClickShield(event) {
    const documentRef = event?.currentTarget?.ownerDocument
      ?? event?.target?.ownerDocument
      ?? (typeof document === "undefined" ? null : document);
    if (typeof documentRef?.addEventListener !== "function") return;
    const key = pointerSequenceKey(event);
    if (!key) return;
    const state = sequenceStateForDocument(documentRef);
    state.guards.set(key, { released: false });
    state.released = state.released.filter((candidate) => candidate !== key);
  }

  function overlayEntry(overlay) {
    let entry = overlayEntries.get(overlay);
    if (!entry) {
      entry = { overlay, active: false, opener: null, observer: null };
      overlayEntries.set(overlay, entry);
    }
    return entry;
  }

  function activateOverlay(overlay, opener = null) {
    if (!overlay) return false;
    const entry = overlayEntry(overlay);
    const index = overlayStack.indexOf(entry);
    if (index >= 0) overlayStack.splice(index, 1);
    entry.active = true;
    if (opener) entry.opener = opener;
    overlayStack.push(entry);
    return true;
  }

  function deactivateOverlay(overlay) {
    const entry = overlayEntries.get(overlay);
    if (!entry) return false;
    const index = overlayStack.indexOf(entry);
    if (index >= 0) overlayStack.splice(index, 1);
    entry.active = false;
    return true;
  }

  function topOverlayEntry() {
    return overlayStack.at(-1) ?? null;
  }

  function canActivateFromInteraction(entry) {
    const top = topOverlayEntry();
    if (!top) return true;
    return top.overlay?.contains?.(entry.overlay) === true;
  }

  function ownsTopOverlay(entry) {
    if (!entry.active && canActivateFromInteraction(entry)) activateOverlay(entry.overlay);
    return topOverlayEntry() === entry;
  }

  function resolvedFocusTarget(value, event) {
    return typeof value === "function" ? value(event) : value;
  }

  function canRestoreFocus(target) {
    return Boolean(target?.isConnected)
      && typeof target.focus === "function"
      && target.disabled !== true
      && !target.closest?.("[inert], [hidden]");
  }

  function topOverlayFocusTarget() {
    const overlay = topOverlayEntry()?.overlay;
    const focusable = overlay?.querySelectorAll?.([
      "[autofocus]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(", ")) ?? [];
    return [...focusable].find(canRestoreFocus) ?? null;
  }

  function restoreFocus(returnFocus, fallbackFocus, event) {
    const documentRef = event?.currentTarget?.ownerDocument
      ?? event?.target?.ownerDocument
      ?? (typeof document === "undefined" ? null : document);
    const schedule = typeof window.queueMicrotask === "function"
      ? window.queueMicrotask.bind(window)
      : (callback) => Promise.resolve().then(callback);
    schedule(() => {
      const preferred = resolvedFocusTarget(returnFocus, event);
      const fallback = resolvedFocusTarget(fallbackFocus, event);
      const overlayFallback = topOverlayFocusTarget(documentRef);
      const target = canRestoreFocus(preferred)
        ? preferred
        : canRestoreFocus(fallback)
          ? fallback
          : canRestoreFocus(overlayFallback) ? overlayFallback : null;
      target?.focus?.({ preventScroll: true });
    });
  }

  function dismissFromPointerDown(event, entry, close, { returnFocus = null, fallbackFocus = null } = {}) {
    if (!isPrimaryPointerDown(event)) return false;
    consumeEvent(event);
    installCompatibilityClickShield(event);
    deactivateOverlay(entry.overlay);
    close(event);
    restoreFocus(returnFocus, fallbackFocus, event);
    return true;
  }

  function installDismissibleOverlay({
    dialog,
    close,
    content = null,
    returnFocus = null,
    fallbackFocus = null,
  } = {}) {
    if (!dialog || typeof dialog.addEventListener !== "function" || typeof close !== "function") {
      return () => {};
    }
    let capturedOpener = null;
    const entry = overlayEntry(dialog);
    const beforeToggleHandler = (event) => {
      if (event?.newState !== "open") {
        if (event?.newState === "closed") deactivateOverlay(dialog);
        return;
      }
      const activeElement = dialog.ownerDocument?.activeElement;
      if (activeElement && activeElement !== dialog && !dialog.contains?.(activeElement)) {
        capturedOpener = activeElement;
      }
      activateOverlay(dialog, capturedOpener);
    };
    const focusReturn = returnFocus ?? (() => capturedOpener ?? entry.opener);
    const pointerDownHandler = (event) => {
      if (!isDialogBackdropPointerDown(event, dialog, content)) return;
      if (!ownsTopOverlay(entry)) return;
      dismissFromPointerDown(event, entry, close, { returnFocus: focusReturn, fallbackFocus });
    };
    const cancelHandler = (event) => {
      if (!ownsTopOverlay(entry)) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      deactivateOverlay(dialog);
      close(event);
      restoreFocus(focusReturn, fallbackFocus, event);
    };
    const closeHandler = () => deactivateOverlay(dialog);
    dialog.addEventListener("beforetoggle", beforeToggleHandler);
    dialog.addEventListener("pointerdown", pointerDownHandler);
    dialog.addEventListener("cancel", cancelHandler);
    dialog.addEventListener("close", closeHandler);
    return () => {
      deactivateOverlay(dialog);
      dialog.removeEventListener?.("beforetoggle", beforeToggleHandler);
      dialog.removeEventListener?.("pointerdown", pointerDownHandler);
      dialog.removeEventListener?.("cancel", cancelHandler);
      dialog.removeEventListener?.("close", closeHandler);
    };
  }

  function installScrimDismiss({
    scrim,
    close,
    returnFocus = null,
    fallbackFocus = null,
  } = {}) {
    if (!scrim || typeof scrim.addEventListener !== "function" || typeof close !== "function") {
      return () => {};
    }
    const entry = overlayEntry(scrim);
    const pointerDownHandler = (event) => {
      if (event.target !== scrim) return;
      if (!ownsTopOverlay(entry)) return;
      dismissFromPointerDown(event, entry, close, { returnFocus, fallbackFocus });
    };
    scrim.addEventListener("pointerdown", pointerDownHandler);
    return () => {
      deactivateOverlay(scrim);
      scrim.removeEventListener?.("pointerdown", pointerDownHandler);
    };
  }

  window.AgentHubModalOverlays = Object.freeze({
    createPhosphorXIcon,
    activateOverlay,
    deactivateOverlay,
    installModalCloseIcons,
    installScrimDismiss,
    installDismissibleOverlay,
    isDialogBackdropPointerDown,
    modalCloseIconSelectors: MODAL_CLOSE_ICON_SELECTORS,
  });

  installModalCloseIcons(typeof document === "undefined" ? null : document);
})();
