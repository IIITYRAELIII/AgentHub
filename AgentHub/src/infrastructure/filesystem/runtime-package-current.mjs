import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { packageDigest, packageBindingDigest } from "../../domain/runtime-package-identity.mjs";
import { packageDirectory } from "./runtime-package-target.mjs";

export async function assertOldPackageCurrent(binding, { requireInstance = false } = {}) {
  const root = binding.runtimeRoot;
  if (!binding.roots || packageBindingDigest(await packageDirectory(root)) !== packageBindingDigest(binding.roots.runtime)
    || packageBindingDigest(await packageDirectory(binding.dataDir)) !== packageBindingDigest(binding.roots.data)
    || await realpath(root) !== root
    || packageDigest(await readFile(path.join(root, "current.json"))) !== binding.old.currentSha256
    || packageDigest(await readFile(path.join(root, "releases", binding.old.releaseId,
      "runtime-manifest.json"))) !== binding.old.manifestSha256) {
    throw new Error("Admitted old runtime identity changed");
  }
  if (requireInstance) {
    const lock = JSON.parse(await readFile(path.join(binding.dataDir, "bot.lock"), "utf8"));
    if (lock.pid !== binding.old.pid || lock.releaseId !== binding.old.releaseId
      || packageDigest(lock.instanceToken ?? "") !== binding.old.instanceSha256) {
      throw new Error("Admitted old instance changed");
    }
  }
}
