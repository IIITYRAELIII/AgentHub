"use strict";

(() => {
  const TELEGRAM_RUNTIME_URL = "https://telegram.org/js/telegram-web-app.js?63";
  const TELEGRAM_LAUNCH_PARAMETERS = new Set([
    "tgWebAppData",
    "tgWebAppPlatform",
    "tgWebAppVersion",
  ]);

  function hasTelegramLaunchParameters(value) {
    const parameters = new URLSearchParams(String(value ?? "").replace(/^[?#]/u, ""));
    return [...TELEGRAM_LAUNCH_PARAMETERS].some((name) => parameters.has(name));
  }

  const telegramLaunch = Boolean(
    window.TelegramWebviewProxy
    || window.TelegramWebviewProxyProto
    || hasTelegramLaunchParameters(window.location.hash)
    || hasTelegramLaunchParameters(window.location.search),
  );
  if (
    !telegramLaunch
    || document.readyState !== "loading"
    || window.AgentHubTelegramRuntimeRequested === true
  ) return;

  window.AgentHubTelegramRuntimeRequested = true;
  document.write(`<script src="${TELEGRAM_RUNTIME_URL}"><\/script>`);
})();
