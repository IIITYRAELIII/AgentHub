(() => {
  const title = document.querySelector("#transfer-title");
  const message = document.querySelector("#transfer-message");
  const file = document.querySelector("#transfer-file");
  const name = document.querySelector("#transfer-name");
  const size = document.querySelector("#transfer-size");
  const expiry = document.querySelector("#transfer-expiry");
  const warning = document.querySelector("#transfer-warning");
  const progressWrap = document.querySelector("#transfer-progress-wrap");
  const progressBar = document.querySelector("#transfer-progress-bar");
  const progressLabel = document.querySelector("#transfer-progress-label");
  const primary = document.querySelector("#transfer-primary");
  const secondary = document.querySelector("#transfer-secondary");
  const alert = document.querySelector("#transfer-alert");
  const originalUrl = window.location.href;
  let capability = null;
  let metadata = null;
  let keyPair = null;
  let writable = null;
  let written = 0;
  let pendingPlanRequestId = "";
  let sessionSelector = "";

  const bytesLabel = (value) => {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} МБ`;
  };
  const base64url = (value) => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  };
  const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
  const formatDate = (value) => new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const setButton = (button, label, handler) => {
    button.hidden = !label;
    button.textContent = label || "";
    button.onclick = handler || null;
    button.disabled = false;
  };
  const clearActions = () => { setButton(primary, ""); setButton(secondary, ""); };
  const setState = (heading, body, { error = false } = {}) => {
    title.textContent = heading;
    message.textContent = body;
    message.setAttribute("role", error ? "alert" : "status");
    alert.hidden = true;
    alert.textContent = "";
  };
  async function api(action, body, extraHeaders = {}) {
    const sessionAction = ["plan", "download"].includes(action);
    if (sessionAction && !/^[A-Za-z0-9_-]{43}$/u.test(sessionSelector)) throw new Error("missing session selector");
    const endpoint = sessionAction
      ? `/transfer/api/session/${sessionSelector}/${action}`
      : `/transfer/api/${action}`;
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw Object.assign(new Error("unavailable"), { status: response.status });
    return response;
  }
  function parseCapability() {
    const match = /^#v1\.([A-Za-z0-9_-]{1,32})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(location.hash);
    return match ? { kid: match[1], shareId: match[2], secret: match[3] } : null;
  }
  function isWebView() {
    return /(?:; wv\)|Telegram|FBAN|FBAV|Instagram|Electron|VSCode)/iu.test(navigator.userAgent)
      || Boolean(window.Telegram?.WebApp);
  }
  function supported() {
    return window.isSecureContext && Boolean(crypto?.subtle) && typeof window.showSaveFilePicker === "function";
  }
  async function thumbprint(publicJwk) {
    const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y });
    return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  }
  async function signPayload(payload, type, jkt) {
    const protectedHeader = base64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: type, kid: jkt })));
    const encodedPayload = base64url(new TextEncoder().encode(payload));
    const signingInput = new TextEncoder().encode(`${protectedHeader}.${encodedPayload}`);
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, signingInput);
    return `${protectedHeader}.${encodedPayload}.${base64url(signature)}`;
  }
  function showReady() {
    setState("Получение файла", "Файл готов к защищённой загрузке.");
    file.hidden = false;
    name.textContent = metadata.name;
    size.textContent = bytesLabel(metadata.size);
    expiry.textContent = `Доступна до ${formatDate(metadata.expiresAt)}`;
    warning.hidden = false;
    warning.textContent = "Первый получатель, который нажмёт „Скачать“, закрепит ссылку за этим браузером.";
    setButton(primary, "Скачать", () => void begin());
    setButton(secondary, "");
  }
  function showUnavailable() {
    file.hidden = true;
    warning.hidden = true;
    progressWrap.hidden = true;
    clearActions();
    setState("Ссылка недоступна", "Загрузка по этой ссылке больше недоступна. Попросите отправителя создать новую ссылку.", { error: true });
  }
  function showUnsupported() {
    file.hidden = true;
    warning.hidden = true;
    clearActions();
    setState("Защищённая загрузка недоступна", "В этом браузере нельзя безопасно загрузить файл. Ссылка не использована. Откройте её в поддерживаемом браузере.", { error: true });
  }
  function showWebView() {
    file.hidden = true;
    warning.hidden = true;
    setState("Защищённая загрузка выполняется во внешнем браузере.", "Скопируйте ссылку и откройте её во внешнем браузере. Ссылка не будет использована внутри WebView.");
    setButton(primary, "Копировать ссылку", async () => {
      try { await navigator.clipboard.writeText(originalUrl); message.textContent = "Ссылка скопирована"; }
      catch { message.textContent = "Не удалось скопировать ссылку. Выделите её в адресной строке."; }
    });
    setButton(secondary, "");
  }
  function updateProgress() {
    progressWrap.hidden = false;
    const percent = metadata?.size ? Math.min(100, written / metadata.size * 100) : 0;
    progressBar.style.width = `${percent}%`;
    progressWrap.setAttribute("role", "progressbar");
    progressWrap.setAttribute("aria-valuemin", "0");
    progressWrap.setAttribute("aria-valuemax", String(metadata.size));
    progressWrap.setAttribute("aria-valuenow", String(written));
    progressLabel.textContent = `${bytesLabel(written)} из ${bytesLabel(metadata.size)}`;
  }
  async function begin() {
    primary.disabled = true;
    alert.hidden = true;
    try {
      const handle = await showSaveFilePicker({ suggestedName: metadata.name });
      writable = await handle.createWritable({ keepExistingData: false });
      keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      const jkt = await thumbprint(publicJwk);
      const claimId = randomToken();
      const challenge = await (await api("challenge", { ...capability, claimId, publicJwk })).json();
      const proof = await signPayload(challenge.payload, "agenthub-transfer-claim+jws", jkt);
      const claimEnvelope = { ...capability, payload: challenge.payload, proof, publicJwk };
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const claimResponse = await api("claim", claimEnvelope);
            const claimReceipt = await claimResponse.json();
            if (!/^[A-Za-z0-9_-]{43}$/u.test(String(claimReceipt.session ?? ""))) throw new Error("invalid claim receipt");
            sessionSelector = claimReceipt.session;
            break;
          } catch (error) {
            const retryable = !error?.status || [408, 500, 502, 503, 504].includes(Number(error.status));
            if (!retryable || attempt === 1) throw error;
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
        }
      } catch {
        await writable.abort().catch(() => {});
        writable = null;
        sessionStorage.setItem("agenthub-transfer-claim-ambiguous", capability.shareId);
        file.hidden = true;
        warning.hidden = true;
        progressWrap.hidden = true;
        clearActions();
        setState("Не удалось подтвердить начало загрузки", "Ссылка могла быть использована. Попросите отправителя проверить статус.", { error: true });
        return;
      }
      sessionStorage.setItem("agenthub-transfer-last-claimed", capability.shareId);
      history.replaceState(null, "", location.pathname);
      written = 0;
      await download();
    } catch (error) {
      await writable?.abort().catch(() => {});
      writable = null;
      if (error?.name === "AbortError" || error?.name === "NotAllowedError") {
        message.textContent = "Ссылка не использована. Выберите место сохранения, чтобы продолжить.";
        primary.disabled = false;
        return;
      }
      showUnsupported();
    }
  }
  async function download() {
    if (!keyPair || !writable) {
      clearActions();
      setState("Продолжить загрузку нельзя", "Защищённый ключ этого браузера недоступен. Попросите отправителя создать новую ссылку.", { error: true });
      return;
    }
    setState("Загрузка файла", "Не закрывайте эту страницу до завершения записи.");
    warning.hidden = true;
    clearActions();
    updateProgress();
    try {
      pendingPlanRequestId ||= randomToken();
      const planResponse = await api("plan", { requestId: pendingPlanRequestId, start: written, end: metadata.size - 1 });
      const plan = await planResponse.json();
      pendingPlanRequestId = "";
      const payload = JSON.parse(plan.payload);
      const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      const jkt = await thumbprint(publicJwk);
      const proof = await signPayload(plan.payload, "agenthub-transfer-download+jws", jkt);
      const response = await api("download", { payload: plan.payload, proof }, {
        Range: `bytes=${payload.start}-${payload.end}`,
        "If-Range": payload.etag,
      });
      const reader = response.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        await writable.write({ type: "write", position: written, data: part.value });
        written += part.value.byteLength;
        updateProgress();
      }
      if (written !== metadata.size) throw new Error("short transfer");
      await writable.close();
      writable = null;
      clearActions();
      progressWrap.hidden = true;
      setState("Файл сохранён", "Передача завершена и запись файла закрыта.");
    } catch (error) {
      if (error?.status) {
        await writable?.abort().catch(() => {});
        writable = null;
        clearActions();
        setState("Продолжить загрузку нельзя", "Защищённый ключ этого браузера недоступен. Попросите отправителя создать новую ссылку.", { error: true });
        return;
      }
      setState("Загрузка прервана", "Продолжение возможно только в этом браузере и его локальном хранилище, пока доступен локальный защищённый ключ.", { error: true });
      setButton(primary, "Продолжить загрузку", () => void download());
    }
  }
  async function start() {
    if (isWebView()) { showWebView(); return; }
    capability = parseCapability();
    if (!capability) {
      if (sessionStorage.getItem("agenthub-transfer-last-claimed")) {
        setState("Продолжить загрузку нельзя", "Защищённый ключ этого браузера недоступен. Попросите отправителя создать новую ссылку.", { error: true });
      } else showUnavailable();
      return;
    }
    if (!supported()) { showUnsupported(); return; }
    try {
      metadata = await (await api("inspect", capability)).json();
      showReady();
    } catch { showUnavailable(); }
  }
  void start();
})();
