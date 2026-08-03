import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { protectRuntimeConfig } from "./runtime-security.mjs";

const BOOLEAN = "boolean";
const INTEGER = "integer";
const CHOICE = "choice";

/**
 * The deliberately small, non-secret subset of runtime configuration that
 * may be edited from the Server page.  Paths, credentials and identifiers
 * never belong here.
 */
export const SERVER_CONFIGURATION_FIELDS = Object.freeze([
  { key: "autoApproveOnStart", name: "Автоподтверждение при запуске", hint: "Команды и правки файлов выполняются без запроса. Выключено — Hub спрашивает разрешение на каждое действие агента.", type: BOOLEAN },
  { key: "guardConcurrentRepositoryWrites", name: "Защита параллельной записи", hint: "Не даёт двум задачам писать в один репозиторий одновременно: вторая ждёт, пока первая закончит ход.", type: BOOLEAN },
  { key: "codexRolloutContext.enabled", name: "История ходов Codex", hint: "Codex получает историю прошлых ходов задачи. Выключено — каждый ход начинается с чистого контекста.", type: BOOLEAN },
  {
    key: "codexSandboxMode",
    name: "Политика доступа Codex",
    hint: "Только рабочая папка ограничивает запись проектом и отключает сеть. Полный доступ снимает это ограничение; Windows-режим unelevated настраивается отдельно в ~/.codex/config.toml.",
    type: CHOICE,
    choices: [
      { value: "workspace-write", label: "Только рабочая папка" },
      { value: "danger-full-access", label: "Полный доступ" },
    ],
    environment: "CODEX_SANDBOX_MODE",
  },
  { key: "codexRpcTimeoutSeconds", name: "Тайм-аут ответа Codex", hint: "Сколько Hub ждёт ответа Codex на один вызов, прежде чем считать ход зависшим.", type: INTEGER, min: 1, max: 3600, unit: "с", environment: "CODEX_RPC_TIMEOUT_SECONDS" },
  { key: "deferredInputTtlHours", name: "Хранение очереди входящих", hint: "Сколько ждёт сообщение, отправленное занятому агенту, прежде чем его отбросят.", type: INTEGER, min: 1, max: 8760, unit: "ч" },
  { key: "progressStartDelayMs", name: "Задержка индикатора работы", hint: "Через сколько после начала хода появляется индикатор. Больше — меньше мельканий на коротких ходах.", type: INTEGER, min: 1, max: 60000, unit: "мс" },
  { key: "deliveryRetryIntervalSeconds", name: "Интервал повторной доставки", hint: "Пауза перед повтором, если сообщение или уведомление не удалось доставить.", type: INTEGER, min: 1, max: 3600, unit: "с" },
  { key: "logMaxFiles", name: "Хранение журналов", hint: "Сколько файлов журнала Hub держит, прежде чем удалять самые старые.", type: INTEGER, min: 1, max: 100, unit: "файлов" },
]);

const FIELDS_BY_KEY = new Map(SERVER_CONFIGURATION_FIELDS.map((field) => [field.key, field]));

function getAtPath(source, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => value?.[key], source);
}

function setAtPath(target, dottedPath, value) {
  const keys = dottedPath.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  current[keys.at(-1)] = value;
}

function normalizeValue(field, value) {
  if (field.type === BOOLEAN) {
    if (typeof value !== "boolean") throw new Error(`«${field.name}»: ожидается переключатель`);
    return value;
  }
  if (field.type === CHOICE) {
    const selected = String(value ?? "").trim();
    if (!field.choices?.some((choice) => choice.value === selected)) {
      throw new Error(`«${field.name}»: выберите одно из допустимых значений`);
    }
    return selected;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < field.min || number > field.max) {
    throw new Error(`«${field.name}»: укажите целое число от ${field.min} до ${field.max}`);
  }
  return number;
}

function displayValue(field, value) {
  if (field.type === BOOLEAN) return value ? "Включено" : "Выключено";
  if (field.type === CHOICE) return field.choices.find((choice) => choice.value === value)?.label ?? String(value ?? "");
  return `${value} ${field.unit}`;
}

/** Projects the safe editable subset for every client surface. */
export function serverConfigurationEntries(config, pending = {}) {
  return SERVER_CONFIGURATION_FIELDS.map((field) => {
    const configured = getAtPath(config, field.key);
    const hasPending = Object.hasOwn(pending, field.key);
    const value = hasPending ? pending[field.key] : configured;
    const entry = {
      key: field.key,
      name: field.name,
      hint: field.hint ?? "",
      type: field.type,
      value,
      display: displayValue(field, value),
      unit: field.unit ?? "",
      min: field.min ?? null,
      max: field.max ?? null,
      pending: hasPending,
    };
    if (field.type === CHOICE) entry.choices = field.choices;
    return entry;
  });
}

/**
 * Atomically persists one or several whitelisted settings.  It intentionally
 * preserves every unrelated key in config.json, including secrets.
 */
export async function updateServerConfiguration({
  configPath,
  changes,
  environment = process.env,
  protectConfig = protectRuntimeConfig,
}) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("Передайте изменяемые параметры конфигурации");
  }
  const entries = Object.entries(changes);
  if (!entries.length) throw new Error("Нет изменений конфигурации");
  const normalized = {};
  for (const [key, value] of entries) {
    const field = FIELDS_BY_KEY.get(key);
    if (!field) throw new Error("Этот параметр нельзя менять из интерфейса Hub");
    if (field.environment && String(environment[field.environment] ?? "").trim()) {
      throw new Error(`«${field.name}» задан через ${field.environment}; измените переменную окружения`);
    }
    normalized[key] = normalizeValue(field, value);
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Не удалось прочитать конфигурацию: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Конфигурация должна быть JSON-объектом");
  for (const [key, value] of Object.entries(normalized)) setAtPath(raw, key, value);

  const directory = path.dirname(configPath);
  const temporary = path.join(directory, `.${path.basename(configPath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await rename(temporary, configPath);
    await protectConfig(configPath, { environment });
  } finally {
    await unlink(temporary).catch(() => null);
  }
  return normalized;
}
