import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export function normalizedRecipeExecutor(value) {
  if (!value || value.schema !== 1 || !path.isAbsolute(value.root ?? "")
      || typeof value.name !== "string" || !value.name || typeof value.version !== "string" || !value.version
      || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? "")
      || !/^\d+$/u.test(value.directory?.dev ?? "") || !/^\d+$/u.test(value.directory?.ino ?? "")) {
    throw new TypeError("Invalid release recipe executor identity");
  }
  const result = { schema: 1, root: value.root, name: value.name, version: value.version,
    sha256: value.sha256, directory: { dev: value.directory.dev, ino: value.directory.ino } };
  if (!isDeepStrictEqual(result, value)) throw new TypeError("Release recipe executor fields differ");
  return result;
}

export function normalizedRecipeAuthorization(value, targets) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.apiVersion !== 1 || typeof value.id !== "string" || !value.id.trim()
      || !value.configuration || typeof value.configuration !== "object" || Array.isArray(value.configuration)
      || !Array.isArray(value.targetOrder)
      || value.targetOrder.length !== targets.length
      || new Set(value.targetOrder).size !== targets.length
      || targets.some(target => !value.targetOrder.includes(target.targetId))) {
    throw new TypeError("Invalid release recipe authorization");
  }
  const configuration = JSON.parse(JSON.stringify(value.configuration));
  if (!isDeepStrictEqual(configuration, value.configuration)) throw new TypeError("Recipe configuration must be immutable JSON data");
  return { recipe: { apiVersion: 1, id: value.id, configuration, executor: normalizedRecipeExecutor(value.executor), targetOrder: [...value.targetOrder] } };
}
