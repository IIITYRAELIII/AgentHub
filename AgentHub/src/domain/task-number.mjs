export const WORKSPACE_TASK_PREFIX_SETTING = "taskPrefix";

const TASK_PREFIX_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,38}[\p{L}\p{N}])?$/u;
const TASK_NUMBER_PATTERN = /^([\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,68}[\p{L}\p{N}])?)-(\d{1,9})$/u;

export function normalizedWorkspaceTaskPrefix(value, { allowEmpty = true } = {}) {
  const prefix = String(value ?? "").trim();
  if (!prefix && allowEmpty) return "";
  if (!prefix || prefix.length > 40 || !TASK_PREFIX_PATTERN.test(prefix) || prefix.includes("..")) {
    throw new Error("Префикс Workspace должен содержать только буквы, цифры, точку, дефис или подчёркивание");
  }
  return prefix;
}

export function normalizedTaskNumber(value, { allowEmpty = true } = {}) {
  const taskNumber = String(value ?? "").trim();
  if (!taskNumber && allowEmpty) return "";
  const match = TASK_NUMBER_PATTERN.exec(taskNumber);
  const ordinal = Number(match?.[2]);
  if (!match || taskNumber.length > 80 || taskNumber.includes("..") || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("Номер Task должен иметь формат ПРЕФИКС-N, где N — положительное целое число");
  }
  return taskNumber;
}

export function workspaceTaskPrefix(settings) {
  return normalizedWorkspaceTaskPrefix(settings?.[WORKSPACE_TASK_PREFIX_SETTING]);
}

export function workspaceSettingsWithTaskPrefix(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  return {
    ...source,
    [WORKSPACE_TASK_PREFIX_SETTING]: normalizedWorkspaceTaskPrefix(source[WORKSPACE_TASK_PREFIX_SETTING]),
  };
}

export function taskNumberParts(value) {
  const taskNumber = normalizedTaskNumber(value, { allowEmpty: false });
  const match = TASK_NUMBER_PATTERN.exec(taskNumber);
  const ordinal = Number(match[2]);
  return { prefix: match[1], ordinal };
}
