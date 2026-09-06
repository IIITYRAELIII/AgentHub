(() => {
  "use strict";

  const MAX_URL_LENGTH = 2_048;
  const BLOCKED_HOST_SUFFIXES = [
    "alt",
    "arpa",
    "example",
    "internal",
    "invalid",
    "lan",
    "local",
    "localhost",
    "onion",
    "test",
  ];
  const BLOCKED_DOMAIN_TREES = [
    "example.com",
    "example.net",
    "example.org",
  ];

  function normalizedIpv4(hostname) {
    const parts = String(hostname).split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return false;
    return parts.every((part) => Number(part) >= 0 && Number(part) <= 255);
  }

  function normalizedHostname(hostname) {
    return String(hostname ?? "").toLowerCase().replace(/\.+$/u, "");
  }

  function domainOrSubdomain(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }

  function blockedEmbeddedHostname(hostname) {
    const host = normalizedHostname(hostname);
    return !host
      || host === "localhost"
      || !host.includes(".")
      || host.includes(":")
      || normalizedIpv4(host)
      || BLOCKED_HOST_SUFFIXES.some((suffix) => domainOrSubdomain(host, suffix))
      || BLOCKED_DOMAIN_TREES.some((domain) => domainOrSubdomain(host, domain));
  }

  function normalizeEmbeddedBrowserUrl(value, { pageUrl = "https://agent-hub.invalid/" } = {}) {
    const raw = String(value ?? "").trim();
    if (!raw) return { ok: false, error: "Введи адрес сайта." };
    if (raw.length > MAX_URL_LENGTH) return { ok: false, error: "Адрес слишком длинный." };

    let target;
    try {
      target = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`);
    } catch {
      return { ok: false, error: "Не удалось распознать адрес." };
    }
    if (target.protocol !== "https:") {
      return { ok: false, error: "Во встроенном просмотре разрешены только HTTPS-сайты." };
    }
    if (target.username || target.password) {
      return { ok: false, error: "Адреса со встроенным логином запрещены." };
    }
    if (blockedEmbeddedHostname(target.hostname)) {
      return { ok: false, error: "Служебные, локальные адреса и IP нельзя открывать внутри Agent Hub." };
    }

    try {
      const page = new URL(pageUrl);
      if (
        target.origin === page.origin
        || normalizedHostname(target.hostname) === normalizedHostname(page.hostname)
      ) {
        return { ok: false, error: "Agent Hub нельзя открыть внутри самого себя." };
      }
    } catch {
      return { ok: false, error: "Контекст страницы не позволяет безопасно открыть сайт." };
    }

    return { ok: true, url: target.href };
  }

  function createEmbeddedBrowserController({ documentRef = document, windowRef = window } = {}) {
    const form = documentRef.querySelector("[data-embedded-browser-form]");
    const input = documentRef.querySelector("[data-embedded-browser-address]");
    const frame = documentRef.querySelector("[data-embedded-browser-frame]");
    const placeholder = documentRef.querySelector("[data-embedded-browser-placeholder]");
    const status = documentRef.querySelector("[data-embedded-browser-status]");
    const external = documentRef.querySelector("[data-embedded-browser-external]");
    const reload = documentRef.querySelector("[data-embedded-browser-reload]");
    const clear = documentRef.querySelector("[data-embedded-browser-clear]");
    const close = documentRef.querySelector("[data-embedded-browser-close]");
    if (!form || !input || !frame || !placeholder || !status || !external || !reload || !clear) {
      return null;
    }

    const messageTrust = windowRef.AgentHubHostMessageTrust;
    const supportsCredentialless = typeof windowRef.HTMLIFrameElement === "function"
      && "credentialless" in windowRef.HTMLIFrameElement.prototype;
    const supportsHostMessageIsolation = typeof messageTrust?.registerEmbeddedFrame === "function"
      && typeof messageTrust?.isTrustedAgentHubHostMessage === "function";
    if (supportsHostMessageIsolation) messageTrust.registerEmbeddedFrame(frame);
    /* A runtime remount may discover a replaced iframe carrying copied state.
       No controller adopts a source it did not create itself. */
    frame.hidden = true;
    frame.removeAttribute("src");
    frame.removeAttribute("srcdoc");
    input.value = "";
    placeholder.hidden = false;
    external.hidden = true;
    external.removeAttribute("href");
    reload.disabled = true;
    clear.disabled = true;
    let currentUrl = "";
    let externalUrl = "";

    function setStatus(text, kind = "info") {
      status.textContent = text;
      status.dataset.kind = kind;
    }

    function unload() {
      if (!currentUrl && !externalUrl && frame.hidden) return;
      if (supportsHostMessageIsolation) messageTrust.registerEmbeddedFrame(frame);
      currentUrl = "";
      externalUrl = "";
      frame.hidden = true;
      frame.removeAttribute("src");
      frame.removeAttribute("srcdoc");
      placeholder.hidden = false;
      external.hidden = true;
      external.removeAttribute("href");
      reload.disabled = true;
      clear.disabled = true;
      setStatus("Страница выгружена. Адрес не сохраняется.");
    }

    function load(rawValue) {
      const result = normalizeEmbeddedBrowserUrl(rawValue, { pageUrl: windowRef.location?.href });
      if (!result.ok) {
        if (externalUrl) {
          input.value = externalUrl;
          input.removeAttribute("aria-invalid");
        } else {
          input.setAttribute("aria-invalid", "true");
        }
        setStatus(result.error, "error");
        return result;
      }
      input.removeAttribute("aria-invalid");
      input.value = result.url;
      externalUrl = result.url;
      external.href = result.url;
      external.hidden = false;
      if (!supportsCredentialless || !supportsHostMessageIsolation) {
        setStatus("Эта версия клиента не поддерживает полную изоляцию просмотра. Открой сайт снаружи.", "error");
        return { ok: false, error: "isolation-unsupported", url: result.url };
      }

      currentUrl = result.url;
      messageTrust.registerEmbeddedFrame(frame);
      placeholder.hidden = true;
      frame.hidden = false;
      frame.src = result.url;
      reload.disabled = false;
      clear.disabled = false;
      setStatus("Открываем в изолированной рамке. Некоторые сайты запрещают встраивание.");
      return result;
    }

    const handleSubmit = (event) => {
      event.preventDefault();
      load(input.value);
    };
    const handleReload = () => {
      if (!currentUrl) return;
      messageTrust.registerEmbeddedFrame(frame);
      frame.src = currentUrl;
      setStatus("Страница перезагружается.");
    };
    const handleExternal = (event) => {
      if (!externalUrl || typeof windowRef.AgentHub?.openExternalUrl !== "function") return;
      event.preventDefault();
      windowRef.AgentHub.openExternalUrl(externalUrl);
    };
    const handleClose = () => {
      documentRef.querySelector('[data-view-button="chat"]')?.click();
    };
    const handleFrameLoad = () => {
      if (currentUrl) {
        setStatus("Запрос завершён. Если страница пустая, сайт запретил встраивание — открой снаружи.");
      }
    };

    form.addEventListener("submit", handleSubmit);
    reload.addEventListener("click", handleReload);
    clear.addEventListener("click", unload);
    external.addEventListener("click", handleExternal);
    close?.addEventListener("click", handleClose);
    frame.addEventListener("load", handleFrameLoad);

    if (!supportsCredentialless || !supportsHostMessageIsolation) {
      setStatus("Встроенный просмотр недоступен: клиент не поддерживает полную изоляцию.", "error");
    }

    function dispose() {
      unload();
      form.removeEventListener("submit", handleSubmit);
      reload.removeEventListener("click", handleReload);
      clear.removeEventListener("click", unload);
      external.removeEventListener("click", handleExternal);
      close?.removeEventListener("click", handleClose);
      frame.removeEventListener("load", handleFrameLoad);
    }

    return Object.freeze({ dispose, load, unload });
  }

  let activeController = null;
  function mount() {
    activeController?.dispose();
    activeController = createEmbeddedBrowserController();
    return activeController;
  }
  const api = Object.freeze({
    MAX_URL_LENGTH,
    blockedEmbeddedHostname,
    createEmbeddedBrowserController,
    deactivate() {
      activeController?.unload();
    },
    mount,
    normalizeEmbeddedBrowserUrl,
  });
  window.AgentHubEmbeddedBrowser = api;
  mount();
})();
