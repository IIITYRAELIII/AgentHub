import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertContourOwnedPath } from "./test-contour-external-effects.mjs";

const OS_KEYS = new Set(["systemroot", "windir", "comspec", "os", "pathext", "processor_architecture", "number_of_processors"]);

export function recordingContourEnvironment(root, environment = process.env) {
  root = assertContourOwnedPath(root, root);
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => OS_KEYS.has(key.toLowerCase()))),
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
    TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    CODEX_HOME: path.join(root, "codex-home"), CLAUDE_CONFIG_DIR: path.join(root, "claude-home"),
  };
}

export async function prepareRecordingContourEnvironment(root, environment = process.env) {
  const result = recordingContourEnvironment(root, environment);
  for (const key of ["HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    assertContourOwnedPath(result[key], root, { optional: true });
    await mkdir(result[key], { recursive: true });
    assertContourOwnedPath(result[key], root);
  }
  return result;
}

export function assertRecordingContourConfiguration(raw, { environment = process.env, telegramEnabled = false } = {}) {
  const forbiddenComponents = ["androidApp", "sharedDashboardBot"];
  if (forbiddenComponents.some((key) => raw.components?.[key] === true)
    || raw.miniApp?.worker?.enabled === true || raw.miniApp?.quickTunnel?.enabled === true
    || raw.sharedDashboardBot?.enabled === true || raw.diagnostics?.sentry?.enabled === true) {
    throw new Error("Remote components are forbidden in the recording contour");
  }
  const credentialKeys = new Set(["apikey", "api_key", "accesstoken", "access_token", "authtoken", "auth_token",
    "authorization", "credential", "credentials", "syncsecretfile", "secretfile", "tokenfile", "dsn"]);
  const inspect = (object) => {
    if (!object || typeof object !== "object") return;
    for (const [key, value] of Object.entries(object)) {
      if (credentialKeys.has(key.toLowerCase()) && value) throw new Error("Credentials are forbidden in recording configuration");
      if (value && typeof value === "object") inspect(value);
    }
  };
  inspect(raw);
  if (Object.entries(environment).some(([key, value]) => value && /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SENTRY_DSN|OPENAI_BASE_URL|ANTHROPIC_BASE_URL)$/i.test(key))) {
    throw new Error("Provider credentials or remote endpoints are forbidden in recording environment");
  }
  const token = environment.TELEGRAM_BOT_TOKEN ?? raw.telegramBotToken;
  if (token && token !== "123:test-contour-token" && token !== "0:journal-only") throw new Error("Production Telegram token is forbidden in recording configuration");
  if (telegramEnabled) {
    const url = new URL(environment.TELEGRAM_API_BASE_URL ?? raw.telegramApiBaseUrl ?? "https://api.telegram.org");
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw new Error("Recording Telegram requires an explicit loopback HTTP endpoint");
    }
  }
}
