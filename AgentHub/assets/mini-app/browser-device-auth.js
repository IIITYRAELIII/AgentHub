"use strict";

(() => {
  const telegramInitData = String(window.Telegram?.WebApp?.initData ?? "");
  const localAccess = /^#access=[A-Za-z0-9_-]{43,128}$/u.test(window.location.hash);
  const managedSurface = Boolean(
    telegramInitData
    || window.AgentHubAndroid
    || window.__agentHubVscode
    || localAccess
    || window.location.protocol === "vscode-webview:",
  );
  if (managedSurface) {
    window.AgentHubBrowserDeviceReady = Promise.resolve();
    return;
  }

  const DATABASE_NAME = "agent-hub-browser-device";
  const STORE_NAME = "credentials";
  const RECORD_KEY = "current";
  const PAIRING_CODE_LENGTH = 20;
  const SESSION_REFRESH_MARGIN_MS = 60_000;
  const textEncoder = new TextEncoder();
  let accessToken = "";
  let sessionExpiresAt = 0;
  let credential = null;
  let authentication = null;
  let refreshTimer = null;
  let autoSubmitTimer = null;
  let resolveReady;

  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  window.AgentHubBrowserDeviceReady = ready;

  function base64Url(bytes) {
    let binary = "";
    const value = new Uint8Array(bytes);
    for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value[index]);
    return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
  }

  function platformLabel() {
    const platform = String(navigator.userAgentData?.platform ?? navigator.platform ?? "").trim();
    if (/win/iu.test(platform)) return "Windows";
    if (/mac/iu.test(platform)) return "macOS";
    if (/linux/iu.test(platform)) return "Linux";
    return platform || "Browser";
  }

  function browserLabel() {
    const brands = navigator.userAgentData?.brands ?? [];
    const brand = brands.find((item) => !/not.?a.?brand/iu.test(item.brand))?.brand
      ?? (/Edg\//u.test(navigator.userAgent) ? "Edge"
        : /Chrome\//u.test(navigator.userAgent) ? "Chrome"
          : /Firefox\//u.test(navigator.userAgent) ? "Firefox"
            : /Safari\//u.test(navigator.userAgent) ? "Safari" : "Браузер");
    return `${brand} · ${platformLabel()}`.slice(0, 80);
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB недоступна")), { once: true });
      request.addEventListener("blocked", () => reject(new Error("Хранилище браузера занято другой вкладкой")), { once: true });
    });
  }

  async function storedCredential() {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
        request.addEventListener("success", () => resolve(request.result ?? null), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
    } finally {
      database.close();
    }
  }

  async function storeCredential(value) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(value, RECORD_KEY);
        transaction.addEventListener("complete", resolve, { once: true });
        transaction.addEventListener("error", () => reject(transaction.error), { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      });
    } finally {
      database.close();
    }
  }

  async function deleteCredential() {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(RECORD_KEY);
        transaction.addEventListener("complete", resolve, { once: true });
        transaction.addEventListener("error", () => reject(transaction.error), { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      });
    } finally {
      database.close();
    }
  }

  async function requestJson(pathname, body) {
    const response = await fetch(pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload?.error ?? `Agent Hub: HTTP ${response.status}`));
    return payload;
  }

  function sessionMessage(deviceId, challengeId, challenge) {
    return ["agent-hub-device-session-v1", deviceId, challengeId, challenge].join("\n");
  }

  function scheduleRefresh() {
    if (refreshTimer != null) window.clearTimeout(refreshTimer);
    const delay = Math.max(1_000, sessionExpiresAt - Date.now() - SESSION_REFRESH_MARGIN_MS);
    refreshTimer = window.setTimeout(() => {
      void ensureSession(true).catch((error) => showPairing(error.message));
    }, delay);
  }

  async function authenticate(value) {
    const challenge = await requestJson("/api/device/challenge", { deviceId: value.deviceId });
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      value.privateKey,
      textEncoder.encode(sessionMessage(value.deviceId, challenge.challengeId, challenge.challenge)),
    );
    const session = await requestJson("/api/device/session", {
      deviceId: value.deviceId,
      challengeId: challenge.challengeId,
      signature: base64Url(signature),
    });
    accessToken = String(session.token ?? "");
    sessionExpiresAt = Number(session.expiresAt) || 0;
    if (!accessToken || sessionExpiresAt <= Date.now()) throw new Error("Agent Hub не создал сессию браузера");
    hidePairing();
    scheduleRefresh();
    resolveReady();
  }

  async function ensureSession(force = false) {
    if (!force && accessToken && sessionExpiresAt - Date.now() > SESSION_REFRESH_MARGIN_MS) return;
    if (!credential) throw new Error("Браузер ещё не добавлен в доверенные устройства");
    if (!authentication) {
      authentication = authenticate(credential).finally(() => {
        authentication = null;
      });
    }
    return authentication;
  }

  function elements() {
    const overlay = document.querySelector("[data-browser-auth]");
    return {
      overlay,
      form: overlay?.querySelector("[data-browser-auth-form]"),
      name: overlay?.querySelector("[data-browser-auth-name]"),
      code: overlay?.querySelector("[data-browser-auth-code]"),
      submit: overlay?.querySelector("[data-browser-auth-submit]"),
      status: overlay?.querySelector("[data-browser-auth-status]"),
    };
  }

  function setStatus(message, kind = "") {
    const { status } = elements();
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function showPairing(message = "") {
    const { overlay, form, name, code, submit } = elements();
    if (!overlay) return;
    overlay.hidden = false;
    document.documentElement.dataset.browserAuth = "required";
    if (name && !name.value) name.value = browserLabel();
    if (form) form.hidden = false;
    if (code) code.disabled = false;
    if (name) name.disabled = false;
    if (submit) submit.disabled = false;
    setStatus(message, message ? "error" : "");
    window.setTimeout(() => code?.focus(), 0);
  }

  function showChecking() {
    const { overlay, form } = elements();
    if (!overlay) return;
    overlay.hidden = false;
    document.documentElement.dataset.browserAuth = "checking";
    if (form) form.hidden = true;
    setStatus("Проверяем доверие к браузеру…");
  }

  function hidePairing() {
    const { overlay } = elements();
    if (overlay) overlay.hidden = true;
    delete document.documentElement.dataset.browserAuth;
  }

  async function pair(event) {
    event.preventDefault();
    const { name, code, submit } = elements();
    const deviceName = String(name?.value ?? "").trim();
    const pairingCode = String(code?.value ?? "").toUpperCase().replace(/[^A-Z2-7]/gu, "");
    if (!deviceName || pairingCode.length !== PAIRING_CODE_LENGTH) {
      setStatus("Укажите название браузера и код сопряжения.", "error");
      return;
    }
    if (submit) submit.disabled = true;
    if (name) name.disabled = true;
    if (code) code.disabled = true;
    setStatus("Добавляем браузер…");
    try {
      const keys = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const publicKey = base64Url(await crypto.subtle.exportKey("spki", keys.publicKey));
      const paired = await requestJson("/api/device/pair", {
        code: pairingCode,
        name: deviceName,
        platform: `Browser · ${platformLabel()}`.slice(0, 40),
        publicKey,
      });
      credential = {
        version: 1,
        deviceId: String(paired.device?.id ?? ""),
        privateKey: keys.privateKey,
        name: deviceName,
        createdAt: Date.now(),
      };
      if (!credential.deviceId) throw new Error("Agent Hub не вернул идентификатор устройства");
      await storeCredential(credential);
      await ensureSession(true);
      window.location.reload();
    } catch (error) {
      setStatus(String(error?.message ?? error), "error");
      if (submit) submit.disabled = false;
      if (name) name.disabled = false;
      if (code) code.disabled = false;
    }
  }

  window.AgentHubBrowserDevice = Object.freeze({
    getAccessToken: () => accessToken,
    ensureSession,
    forget: async () => {
      accessToken = "";
      sessionExpiresAt = 0;
      credential = null;
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      await deleteCredential();
      showPairing();
    },
  });

  async function start() {
    const { form, code, submit } = elements();
    form?.addEventListener("submit", pair);
    code?.addEventListener("input", () => {
      code.value = code.value.toUpperCase().replace(/[^A-Z2-7-]/gu, "").slice(0, 23);
      setStatus("");
      if (autoSubmitTimer != null) window.clearTimeout(autoSubmitTimer);
      const complete = code.value.replace(/-/gu, "").length === PAIRING_CODE_LENGTH;
      if (complete && form && !submit?.disabled) {
        autoSubmitTimer = window.setTimeout(() => {
          autoSubmitTimer = null;
          if (!submit?.disabled) form.requestSubmit();
        }, 0);
      }
    });
    if (!window.isSecureContext || !crypto?.subtle || !window.indexedDB) {
      showPairing("Этот браузер не поддерживает безопасное хранилище ключей.");
      return;
    }
    showChecking();
    try {
      credential = await storedCredential();
      if (!credential?.deviceId || !credential?.privateKey) {
        credential = null;
        showPairing();
        return;
      }
      await ensureSession(true);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/not trusted|invalid device|не довер/iu.test(message)) {
        await deleteCredential().catch(() => {});
        credential = null;
      }
      showPairing(message);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && credential) {
      void ensureSession().catch((error) => showPairing(String(error?.message ?? error)));
    }
  });
  window.addEventListener("pagehide", () => {
    if (refreshTimer != null) window.clearTimeout(refreshTimer);
    if (autoSubmitTimer != null) window.clearTimeout(autoSubmitTimer);
  }, { once: true });

  void start();
})();
