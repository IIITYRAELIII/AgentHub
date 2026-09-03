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

  function isDialogBackdropClick(event, dialog, content = null) {
    if (!event || !dialog || event.target !== dialog) return false;
    const rectSource = content && typeof content.getBoundingClientRect === "function"
      ? content
      : dialog;
    const rect = typeof rectSource.getBoundingClientRect === "function"
      ? rectSource.getBoundingClientRect()
      : null;
    return pointOutsideRect(event, rect);
  }

  function installDismissibleOverlay({ dialog, close, content = null } = {}) {
    if (!dialog || typeof dialog.addEventListener !== "function" || typeof close !== "function") {
      return () => {};
    }
    const clickHandler = (event) => {
      if (isDialogBackdropClick(event, dialog, content)) close(event);
    };
    const cancelHandler = (event) => {
      event?.preventDefault?.();
      close(event);
    };
    dialog.addEventListener("click", clickHandler);
    dialog.addEventListener("cancel", cancelHandler);
    return () => {
      dialog.removeEventListener?.("click", clickHandler);
      dialog.removeEventListener?.("cancel", cancelHandler);
    };
  }

  function installScrimDismiss({ scrim, close } = {}) {
    if (!scrim || typeof scrim.addEventListener !== "function" || typeof close !== "function") {
      return () => {};
    }
    const clickHandler = (event) => close(event);
    scrim.addEventListener("click", clickHandler);
    return () => scrim.removeEventListener?.("click", clickHandler);
  }

  window.AgentHubModalOverlays = Object.freeze({
    createPhosphorXIcon,
    installModalCloseIcons,
    installScrimDismiss,
    installDismissibleOverlay,
    isDialogBackdropClick,
    modalCloseIconSelectors: MODAL_CLOSE_ICON_SELECTORS,
  });

  installModalCloseIcons(typeof document === "undefined" ? null : document);
})();
