import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function comparablePath(value, platform) {
  const normalized = path.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isMainModule(
  moduleUrl,
  argvEntry = process.argv[1],
  {
    platform = process.platform,
    realpathImpl = realpathSync.native,
  } = {},
) {
  if (!argvEntry) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const canonical = (value) => {
    try {
      return realpathImpl(value);
    } catch {
      return path.resolve(value);
    }
  };
  return comparablePath(canonical(modulePath), platform)
    === comparablePath(canonical(argvEntry), platform);
}
