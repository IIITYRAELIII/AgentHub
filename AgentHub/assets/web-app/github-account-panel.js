(() => {
  const states = new WeakMap();
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function render(root, accountState = {}, emit, localAccess = false) {
    if (!root) return;
    let view = states.get(root);
    if (!view) {
      const heading = element("div", "", "github-account-heading");
      const title = element("strong", "GitHub");
      const help = element("details", "", "workspace-task-workflow-help-popover");
      const question = element("summary", "?", "workspace-task-workflow-help");
      question.setAttribute("aria-label", "О подключении GitHub");
      question.setAttribute("aria-describedby", "github-account-help");
      const note = element("div", "Общий Git-профиль Hub и агентов. Вход по одноразовому коду.", "workspace-task-workflow-tooltip");
      note.id = "github-account-help";
      note.setAttribute("role", "tooltip");
      help.append(question, note);
      help.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") help.open = true; });
      help.addEventListener("pointerleave", () => { if (!help.contains(document.activeElement)) help.open = false; });
      help.addEventListener("keydown", event => { if (event.key === "Escape") { help.open = false; question.blur(); } });
      heading.append(title, help);
      const status = element("span", "", "server-component-status");
      const identity = element("small");
      const connect = element("button", "Войти", "chip-button");
      connect.type = "button";
      const disconnect = element("button", "Отключить", "chip-button ghost");
      disconnect.type = "button";
      const login = element("div", "", "github-device-login");
      const instruction = element("small", "Введи этот код на GitHub:");
      const code = element("code");
      code.setAttribute("aria-label", "Код входа GitHub");
      const link = element("a", "Открыть GitHub", "chip-button");
      link.href = "https://github.com/login/device";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const cancel = element("button", "Отменить вход", "chip-button ghost");
      cancel.type = "button";
      login.append(instruction, code, link, cancel);
      login.hidden = true;
      const error = element("small");
      error.setAttribute("role", "status");
      const actions = element("div", "", "server-account-actions");
      actions.append(connect, disconnect);
      root.append(heading, status, identity, actions, login, error);
      view = { status, identity, connect, disconnect, error, login, code, busy: false, localAccess: false, waiting: false };
      states.set(root, view);
      connect.addEventListener("click", () => {
        if (view.busy || !view.localAccess) return;
        view.busy = true;
        error.textContent = "Подготовка входа через GitHub…";
        connect.disabled = disconnect.disabled = true;
        emit("server:github-connect", {});
      });
      cancel.addEventListener("click", () => emit("server:github-cancel", {}));
      disconnect.addEventListener("click", () => {
        if (view.busy || !view.localAccess) return;
        view.busy = true;
        connect.disabled = disconnect.disabled = true;
        emit("server:github-disconnect", {});
      });
    }
    const account = accountState.account;
    view.localAccess = localAccess === true;
    view.status.textContent = ({ connected: "Подключён", disconnected: "Не подключён",
      expired: "Авторизация истекла — войди через GitHub снова" })[accountState.status] ?? "Подключение недоступно";
    view.identity.textContent = account ? `${account.login} · ${account.name} <${account.email}>` : "";
    view.disconnect.hidden = !account;
    view.connect.hidden = view.waiting;
    view.connect.disabled = view.busy || !view.localAccess || accountState.status === "unavailable";
    view.disconnect.disabled = view.busy || !view.localAccess;
  }
  function setLogin(root, login) {
    const view = states.get(root);
    if (!view) return;
    view.waiting = Boolean(login);
    view.login.hidden = !login;
    view.code.textContent = login?.userCode ?? "";
    view.connect.hidden = view.waiting;
    if (login) view.error.textContent = "Ожидание подтверждения на GitHub…";
  }
  function finish(root, message = "") {
    const view = states.get(root);
    if (!view) return;
    view.busy = false;
    view.connect.disabled = view.disconnect.disabled = !view.localAccess;
    view.error.textContent = message;
  }
  window.AgentHubGitHubAccountPanel = { render, finish, setLogin };
})();
