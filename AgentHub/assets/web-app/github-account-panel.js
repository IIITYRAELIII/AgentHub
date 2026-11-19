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
      const title = element("strong", "GitHub");
      const status = element("span", "", "server-component-status");
      const identity = element("small");
      const note = element("small", "Общий Git-профиль Hub и агентов. Доступ ограничен правами вашего токена.");
      const localNote = element("small", "Для подключения откройте Hub на этом компьютере.");
      const form = element("form", "", "server-account-code-row");
      const label = element("label", "Personal access token");
      const input = element("input", "", "server-account-code");
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", "GitHub personal access token");
      const help = element("a", "Создать токен на GitHub");
      help.href = "https://github.com/settings/personal-access-tokens/new";
      help.target = "_blank";
      help.rel = "noopener noreferrer";
      const connect = element("button", "Подключить", "chip-button");
      connect.type = "submit";
      const disconnect = element("button", "Отключить", "chip-button ghost");
      disconnect.type = "button";
      const error = element("small");
      error.setAttribute("role", "status");
      const actions = element("div", "", "server-account-actions");
      actions.append(connect, disconnect);
      label.append(input);
      form.append(label, help, actions);
      root.append(title, status, identity, note, localNote, form, error);
      view = { status, identity, input, connect, disconnect, error, localNote, busy: false, localAccess: false };
      states.set(root, view);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const token = input.value.trim();
        if (!token || view.busy || !view.localAccess) return;
        input.value = "";
        view.busy = true;
        error.textContent = "Проверка подключения…";
        input.disabled = connect.disabled = disconnect.disabled = true;
        emit("server:github-connect", { token });
      });
      disconnect.addEventListener("click", () => {
        if (view.busy || !view.localAccess) return;
        input.value = "";
        view.busy = true;
        input.disabled = connect.disabled = disconnect.disabled = true;
        emit("server:github-disconnect", {});
      });
    }
    const account = accountState.account;
    view.localAccess = localAccess === true;
    view.localNote.hidden = view.localAccess;
    view.status.textContent = ({ connected: "Подключён", disconnected: "Не подключён",
      expired: "Авторизация истекла — переподключите аккаунт" })[accountState.status] ?? "Подключение недоступно";
    view.identity.textContent = account ? `${account.login} · ${account.name} <${account.email}>` : "";
    view.connect.textContent = account ? "Переподключить" : "Подключить";
    view.disconnect.hidden = !account;
    view.input.disabled = view.busy || !view.localAccess;
    view.connect.disabled = view.busy || !view.localAccess || accountState.status === "unavailable";
    view.disconnect.disabled = view.busy || !view.localAccess;
  }
  function finish(root, message = "") {
    const view = states.get(root);
    if (!view) return;
    view.busy = false;
    view.input.disabled = view.connect.disabled = view.disconnect.disabled = !view.localAccess;
    view.error.textContent = message;
    view.input.value = "";
  }
  window.AgentHubGitHubAccountPanel = { render, finish };
})();
