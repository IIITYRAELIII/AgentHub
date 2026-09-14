/* Модель карточки входа в аккаунт провайдера на странице «Сервер».
   Ссылка входа и поле кода есть только у локального клиента, запустившего эту
   же попытку: общий снапшот их не содержит, а код не хранится нигде, кроме поля. */
(function () {
  const LABELS = Object.freeze({ codex: "Codex", claude: "Claude" });
  const STATUS = Object.freeze({
    idle: "Вход не запускался",
    pending: "Ожидает входа в браузере",
    succeeded: "Вход выполнен",
    cancelled: "Вход отменён",
    failed: "Ошибка входа",
  });
  const MAX_CODE_LENGTH = 4096;

  /* `claude auth login` читает из stdin строку вида code#state. */
  function isManualCode(value) {
    const text = String(value ?? "").trim();
    const parts = text.split("#");
    return Boolean(text) && text.length <= MAX_CODE_LENGTH && !/\s/u.test(text)
      && parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
  }

  function accountView(account = {}, local = null) {
    const provider = String(account?.provider ?? "");
    const status = String(account?.status ?? "idle");
    const pending = status === "pending";
    const attemptId = account?.attemptId ? String(account.attemptId) : null;
    const ownAttempt = pending && Boolean(attemptId) && String(local?.attemptId ?? "") === attemptId;
    const authUrl = ownAttempt && /^https:\/\//u.test(String(local?.authUrl ?? "")) ? String(local.authUrl) : null;
    return {
      provider,
      attemptId,
      status,
      label: LABELS[provider] ?? provider,
      statusText: STATUS[status] ?? status,
      error: (status === "failed" || pending) && account?.error ? String(account.error) : null,
      startText: pending ? "Войти заново" : "Войти",
      authUrl,
      canCancel: pending,
      acceptsCode: ownAttempt && provider === "claude",
      codeHint: "Если вход не завершился сам, откройте страницу входа и вставьте показанный код.",
    };
  }

  /* Локальная попытка переживает снапшоты, снятые до её запуска: её удаляет
     только завершение этой же попытки или появление более новой. */
  function retainLocal(account, local) {
    if (!local?.attemptId) return false;
    const attemptId = account?.attemptId ? String(account.attemptId) : null;
    if (attemptId === String(local.attemptId)) return account?.status === "pending";
    return !(attemptId && Number(attemptId) > Number(local.attemptId));
  }

  function codeSubmission(view, draft) {
    if (!view?.acceptsCode || !isManualCode(draft)) return null;
    return { provider: view.provider, attemptId: view.attemptId, code: String(draft).trim() };
  }

  /* Ключ перерисовки без черновика кода: снапшоты не пересоздают поле, пока
     пользователь вводит код. */
  function renderKey(views) {
    return JSON.stringify((views ?? []).map((view) => [
      view.provider, view.attemptId, view.status, view.error, Boolean(view.authUrl), view.acceptsCode,
    ]));
  }

  window.AgentHubProviderLoginPanel = Object.freeze({
    accountView, codeSubmission, isManualCode, renderKey, retainLocal,
  });
})();
