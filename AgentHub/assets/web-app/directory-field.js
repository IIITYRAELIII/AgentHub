"use strict";

(() => {
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const ICON_PATHS = Object.freeze({
    folder: "M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z",
    "caret-right": "M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z",
  });

  function normalizedPath(value) {
    return String(value ?? "").trim();
  }

  function directoryPathSegments(value) {
    const fullPath = normalizedPath(value);
    if (!fullPath) return [];
    if (/^\\\\/u.test(fullPath)) {
      const parts = fullPath.slice(2).split(/[\\/]+/u).filter(Boolean);
      if (parts.length >= 2) return [`\\\\${parts[0]}\\${parts[1]}`, ...parts.slice(2)];
      return [fullPath];
    }
    const drive = fullPath.match(/^([A-Za-z]:)[\\/]*(.*)$/u);
    if (drive) return [drive[1], ...drive[2].split(/[\\/]+/u).filter(Boolean)];
    if (fullPath.startsWith("/")) {
      return ["/", ...fullPath.slice(1).split(/\/+/u).filter(Boolean)];
    }
    return fullPath.split(/[\\/]+/u).filter(Boolean);
  }

  function directoryBreadcrumbSegments(value, maximum = 5) {
    const parts = directoryPathSegments(value);
    const limit = Math.max(4, Math.round(Number(maximum) || 5));
    if (parts.length <= limit) return parts.map((label) => ({ label, collapsed: false }));
    return [
      { label: parts[0], collapsed: false },
      { label: "…", collapsed: true },
      ...parts.slice(-3).map((label) => ({ label, collapsed: false })),
    ];
  }

  function icon(documentRef, name, className) {
    const svg = documentRef.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("data-phosphor-icon", name);
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    const path = documentRef.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", ICON_PATHS[name]);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }

  function element(documentRef, tagName, className, text = "") {
    const node = documentRef.createElement(tagName);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function actionButton(documentRef, className, text, action) {
    const button = element(documentRef, "button", className, text);
    button.type = "button";
    button.dataset.directoryAction = action;
    return button;
  }

  function createDirectoryField(input, options = {}) {
    if (!input?.ownerDocument) throw new TypeError("Directory input is required");
    const documentRef = input.ownerDocument;
    const root = element(documentRef, "div", "directory-field");
    const view = element(documentRef, "div", "directory-field-view");
    const pathButton = actionButton(documentRef, "directory-field-path", "", "edit");
    const breadcrumbs = element(documentRef, "span", "directory-field-breadcrumbs");
    const editButton = actionButton(documentRef, "directory-field-action", "Изменить", "edit");
    const empty = element(documentRef, "div", "directory-field-empty");
    const emptyValue = element(documentRef, "span", "directory-field-empty-value");
    const emptyActions = element(documentRef, "span", "directory-field-empty-actions");
    const emptyBrowse = actionButton(documentRef, "directory-field-action directory-field-action-primary", "Обзор…", "browse");
    const emptyEdit = actionButton(documentRef, "directory-field-action", "Ввести путь", "edit");
    const editor = element(documentRef, "div", "directory-field-editor");
    const commitButton = actionButton(documentRef, "directory-field-action directory-field-action-primary", "Готово", "commit");
    const browseButton = actionButton(documentRef, "directory-field-action", "Обзор…", "browse");
    const status = element(documentRef, "span", "directory-field-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    input.replaceWith(root);
    input.classList.add("directory-field-input");
    input.setAttribute("aria-label", input.getAttribute("aria-label") || "Путь к рабочей директории");
    pathButton.append(icon(documentRef, "folder", "directory-field-folder"), breadcrumbs);
    view.append(pathButton, editButton);
    emptyActions.append(emptyBrowse, emptyEdit);
    empty.append(emptyValue, emptyActions);
    editor.append(input, commitButton, browseButton);
    root.append(view, empty, editor, status);

    let committedValue = normalizedPath(input.value);
    let editingValue = committedValue;
    let busy = false;
    let errorMessage = "";
    let browseAvailable = options.browseAvailable !== false;

    function renderBreadcrumbs(value) {
      breadcrumbs.replaceChildren();
      const segments = directoryBreadcrumbSegments(value);
      segments.forEach((segment, index) => {
        if (index) breadcrumbs.append(icon(documentRef, "caret-right", "directory-field-separator"));
        const part = element(documentRef, "span", "directory-field-segment", segment.label);
        if (segment.collapsed) part.dataset.collapsed = "";
        if (index === segments.length - 1) part.dataset.current = "";
        breadcrumbs.append(part);
      });
    }

    function render() {
      const value = normalizedPath(input.value);
      const disabled = input.disabled;
      const editing = root.dataset.mode === "editing";
      root.dataset.state = value ? "filled" : "empty";
      view.hidden = editing || !value;
      empty.hidden = editing || Boolean(value);
      editor.hidden = !editing;
      root.toggleAttribute("data-disabled", disabled);
      pathButton.disabled = disabled;
      editButton.disabled = disabled;
      emptyEdit.disabled = disabled;
      commitButton.disabled = disabled || busy;
      browseButton.disabled = disabled || busy || !browseAvailable;
      emptyBrowse.disabled = disabled || busy || !browseAvailable;
      const browseTitle = browseAvailable ? "Выбрать каталог через Проводник" : "Доступно в локальном Agent Hub";
      browseButton.title = browseTitle;
      emptyBrowse.title = browseTitle;
      emptyValue.textContent = input.dataset.directoryEmptyLabel || "Каталог не выбран";
      pathButton.title = value;
      renderBreadcrumbs(value);
      if (errorMessage) {
        status.textContent = errorMessage;
        status.dataset.tone = "error";
      } else {
        status.removeAttribute("data-tone");
        status.textContent = value
          ? "Рабочая директория задана."
          : input.dataset.directoryEmptyStatus || "Укажите каталог вручную или выберите через Проводник.";
      }
    }

    function dispatchCommit(source) {
      input.dispatchEvent(new CustomEvent("directorycommit", {
        bubbles: true,
        detail: { source, value: committedValue },
      }));
    }

    function beginEdit() {
      if (input.disabled) return;
      editingValue = committedValue;
      errorMessage = "";
      root.dataset.mode = "editing";
      render();
      input.focus();
      input.select();
    }

    function commit(source = "manual") {
      if (input.disabled) return;
      committedValue = normalizedPath(input.value);
      input.value = committedValue;
      errorMessage = "";
      root.dataset.mode = "view";
      render();
      dispatchCommit(source);
    }

    function cancel() {
      input.value = editingValue;
      committedValue = editingValue;
      errorMessage = "";
      root.dataset.mode = "view";
      render();
    }

    async function browse() {
      if (input.disabled || busy || !browseAvailable || typeof options.browse !== "function") return;
      busy = true;
      errorMessage = "";
      render();
      try {
        const result = await options.browse({ initialPath: normalizedPath(input.value) });
        const selected = normalizedPath(result?.path);
        if (!selected) return;
        input.value = selected;
        committedValue = selected;
        editingValue = selected;
        root.dataset.mode = "view";
        dispatchCommit("browse");
      } catch (error) {
        errorMessage = String(error?.message ?? error ?? "Не удалось открыть Проводник");
        options.onError?.(error);
      } finally {
        busy = false;
        render();
      }
    }

    root.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-directory-action]")?.dataset.directoryAction;
      if (action === "edit") beginEdit();
      else if (action === "commit") commit();
      else if (action === "browse") void browse();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
    input.addEventListener("input", () => {
      errorMessage = "";
      status.textContent = normalizedPath(input.value) ? "Нажмите «Готово», чтобы применить путь." : "Путь будет очищен.";
      status.removeAttribute("data-tone");
    });

    root.dataset.mode = "view";
    render();
    return Object.freeze({
      input,
      root,
      beginEdit,
      cancel,
      commit,
      refresh() {
        committedValue = normalizedPath(input.value);
        editingValue = committedValue;
        root.dataset.mode = "view";
        errorMessage = "";
        render();
      },
      setBrowseAvailable(value) {
        browseAvailable = value === true;
        render();
      },
      setValue(value, { notify = false, source = "external" } = {}) {
        input.value = normalizedPath(value);
        committedValue = input.value;
        editingValue = committedValue;
        root.dataset.mode = "view";
        errorMessage = "";
        render();
        if (notify) dispatchCommit(source);
      },
    });
  }

  window.AgentHubDirectoryField = Object.freeze({
    create: createDirectoryField,
    breadcrumbSegments: directoryBreadcrumbSegments,
    pathSegments: directoryPathSegments,
  });
})();
