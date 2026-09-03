import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { discoverOfficialCodexExecutables } from "./codex-executable.mjs";

const SCHEMA_VERSION = 1;

function identity(candidate) {
  if (!candidate) return null;
  return {
    path: String(candidate.path),
    version: String(candidate.version),
    sha256: String(candidate.sha256),
    publisher: String(candidate.publisher ?? ""),
    source: String(candidate.source ?? ""),
  };
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && String(left.path).toLowerCase() === String(right.path).toLowerCase()
    && left.version === right.version
    && left.sha256 === right.sha256
    && left.publisher === right.publisher);
}

function validIdentity(value) {
  return value && typeof value === "object"
    && typeof value.path === "string" && value.path
    && typeof value.version === "string" && value.version
    && typeof value.sha256 === "string" && /^[A-F0-9]{64}$/.test(value.sha256)
    && typeof value.publisher === "string" && value.publisher;
}

function initialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    active: null,
    selected: null,
    lastKnownGood: null,
    candidate: null,
    failedIdentity: null,
    canary: null,
    status: "uninitialized",
    reason: null,
    lastError: null,
    updatedAt: null,
  };
}

export class CodexExecutableUpdateService {
  #loaded = false;
  #state = initialState();
  #selection = null;
  #verifiedCandidates = [];
  #rollbackIdentity = null;

  constructor({
    stateFile,
    requestedExecutable = "",
    autoUpdateEnabled = true,
    versionPin = "",
    discover = discoverOfficialCodexExecutables,
    runCanary,
    activeRuns = () => [],
    now = () => new Date(),
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    renameImpl = rename,
    unlinkImpl = unlink,
    mkdirImpl = mkdir,
    logger = console,
    platform = process.platform,
  }) {
    if (!stateFile) throw new TypeError("Codex executable state file is required");
    if (typeof runCanary !== "function") throw new TypeError("Codex compatibility canary is required");
    Object.assign(this, {
      stateFile,
      requestedExecutable: String(requestedExecutable ?? "").trim(),
      autoUpdateEnabled: autoUpdateEnabled !== false,
      versionPin: String(versionPin ?? "").trim(),
      discover,
      runCanary,
      activeRuns,
      now,
      readFileImpl,
      writeFileImpl,
      renameImpl,
      unlinkImpl,
      mkdirImpl,
      logger,
      platform,
    });
  }

  async #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#state = await this.#readPersistedState({ allowMissing: true });
  }

  async #readPersistedState({ allowMissing }) {
    try {
      const parsed = JSON.parse(await this.readFileImpl(this.stateFile, "utf8"));
      if (parsed?.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported schema version");
      for (const key of ["active", "selected", "lastKnownGood", "candidate", "failedIdentity"]) {
        if (parsed[key] != null && !validIdentity(parsed[key])) throw new Error(`invalid ${key} identity`);
      }
      return { ...initialState(), ...parsed };
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return initialState();
      throw new Error(`Cannot read Codex executable state: ${error.message}`);
    }
  }

  async #save() {
    this.#state.updatedAt = this.now().toISOString();
    const directory = path.dirname(this.stateFile);
    const temporary = path.join(directory, `.${path.basename(this.stateFile)}.${randomUUID()}.tmp`);
    await this.mkdirImpl(directory, { recursive: true });
    try {
      await this.writeFileImpl(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, "utf8");
      await this.renameImpl(temporary, this.stateFile);
    } finally {
      await this.unlinkImpl(temporary).catch(() => null);
    }
  }

  #findVerified(expected) {
    return this.#verifiedCandidates.find((candidate) => sameIdentity(candidate, expected)) ?? null;
  }

  #legacyVscodeCandidate(candidates) {
    return candidates.find((candidate) => candidate.source.startsWith("vscode")) ?? null;
  }

  #hasActiveCodexRuns() {
    return this.activeRuns().some((run) => (
      run?.provider === "codex" && !["completed", "failed", "cancelled", "aborted"].includes(run?.status)
    ));
  }

  async #select(candidate, status, reason = null) {
    this.#selection = identity(candidate);
    this.#state.selected = identity(candidate);
    this.#state.status = status;
    this.#state.reason = reason;
    this.#state.lastError = null;
    await this.#save();
    return candidate.path;
  }

  async selectForStart() {
    if (this.requestedExecutable) {
      this.#selection = { path: this.requestedExecutable, version: null, sha256: null, source: "manual-override" };
      this.#state.status = "manual-override";
      this.#state.reason = "codexExecutable";
      return this.requestedExecutable;
    }
    await this.#load();
    if (this.platform !== "win32") {
      this.#selection = { path: "codex", version: null, sha256: null, source: "path-fallback" };
      this.#state.status = "path-fallback";
      this.#state.reason = "official-install-discovery-is-windows-only";
      return "codex";
    }

    const discovery = await this.discover();
    this.#verifiedCandidates = discovery.candidates ?? [];
    let candidates = this.#verifiedCandidates;
    if (this.versionPin) candidates = candidates.filter((candidate) => candidate.version === this.versionPin);
    const candidate = candidates[0] ?? null;
    const verifiedLkg = this.#findVerified(this.#state.lastKnownGood);
    const legacy = this.#legacyVscodeCandidate(this.#verifiedCandidates);
    this.#state.candidate = identity(candidate ?? this.#verifiedCandidates[0] ?? null);
    this.#state.rejected = (discovery.rejected ?? []).map((entry) => ({
      path: entry.path,
      source: entry.source,
      error: entry.error,
    }));

    if (this.#rollbackIdentity) {
      const rollback = this.#findVerified(this.#rollbackIdentity);
      this.#rollbackIdentity = null;
      if (!rollback) throw new Error("Last-known-good Codex executable is no longer trusted or installed");
      return this.#select(rollback, "rollback-starting", "candidate-startup-failed");
    }
    if (!candidate) {
      this.#state.status = this.versionPin ? "pin-unavailable" : "no-trusted-candidate";
      this.#state.reason = this.versionPin || null;
      await this.#save();
      throw new Error(this.versionPin
        ? `No trusted installed Codex executable matches pin ${this.versionPin}`
        : "No trusted installed official Codex executable was found");
    }
    if (!this.autoUpdateEnabled) {
      const fallback = verifiedLkg ?? legacy;
      if (!fallback) {
        this.#state.status = "disabled-no-last-known-good";
        this.#state.reason = "automatic-update-disabled";
        await this.#save();
        throw new Error("Automatic Codex executable adoption is disabled and no trusted previous executable is available");
      }
      return this.#select(fallback, "disabled", "automatic-update-disabled");
    }
    if (sameIdentity(candidate, verifiedLkg) || sameIdentity(candidate, this.#state.active)) {
      return this.#select(candidate, this.versionPin ? "pinned" : "current");
    }
    if (sameIdentity(candidate, this.#state.failedIdentity)) {
      const fallback = verifiedLkg ?? legacy;
      if (!fallback || sameIdentity(fallback, candidate)) {
        throw new Error(`Codex ${candidate.version} is blocked after a failed compatibility check`);
      }
      return this.#select(fallback, "candidate-blocked", "failed-identity-unchanged");
    }
    if (this.#hasActiveCodexRuns()) {
      const fallback = verifiedLkg ?? legacy;
      if (!fallback) {
        this.#state.status = "deferred-active-runs";
        this.#state.reason = "no-safe-current-identity";
        await this.#save();
        throw new Error("Codex executable update is deferred while active runs require recovery");
      }
      return this.#select(fallback, "deferred-active-runs", `candidate-${candidate.version}`);
    }

    const startedAt = this.now().toISOString();
    try {
      const result = await this.runCanary(candidate);
      if (result?.ok !== true) throw new Error(result?.error || "compatibility canary did not pass");
      const confirmedDiscovery = await this.discover();
      const confirmedCandidates = confirmedDiscovery.candidates ?? [];
      const confirmed = confirmedCandidates.find((entry) => sameIdentity(entry, candidate));
      if (!confirmed) throw new Error("Codex executable identity changed after compatibility canary");
      this.#verifiedCandidates = confirmedCandidates;
      this.#state.rejected = (confirmedDiscovery.rejected ?? []).map((entry) => ({
        path: entry.path,
        source: entry.source,
        error: entry.error,
      }));
      this.#state.canary = {
        identity: identity(confirmed),
        status: "passed",
        startedAt,
        completedAt: this.now().toISOString(),
        evidence: result.evidence ?? null,
      };
      return this.#select(confirmed, "candidate-starting", this.versionPin ? "version-pin" : "newest-installed");
    } catch (error) {
      this.#state.canary = {
        identity: identity(candidate),
        status: "failed",
        startedAt,
        completedAt: this.now().toISOString(),
        error: error.message,
      };
      this.#state.failedIdentity = identity(candidate);
      this.#state.lastError = error.message;
      const fallback = verifiedLkg ?? legacy;
      if (!fallback || sameIdentity(fallback, candidate)) {
        this.#state.status = "canary-failed";
        this.#state.reason = "no-last-known-good";
        await this.#save();
        throw new Error(`Codex ${candidate.version} compatibility canary failed: ${error.message}`);
      }
      this.#selection = identity(fallback);
      this.#state.selected = identity(fallback);
      this.#state.status = "canary-failed-using-last-known-good";
      this.#state.reason = `candidate-${candidate.version}`;
      await this.#save();
      return fallback.path;
    }
  }

  async verifySelectedForLaunch(expectedPath) {
    const requestedPath = String(expectedPath ?? "").trim();
    const selected = identity(this.#selection);
    if (!requestedPath || !selected
      || selected.path.toLowerCase() !== requestedPath.toLowerCase()) {
      throw new Error("Codex executable launch path does not match the selected identity");
    }
    if (["manual-override", "path-fallback"].includes(selected.source)) return requestedPath;

    await this.#load();
    if (!validIdentity(selected)) throw new Error("Codex executable launch identity is incomplete");
    const durable = await this.#readPersistedState({ allowMissing: false });
    if (!sameIdentity(selected, durable.selected)) {
      throw new Error("Durable selected Codex executable identity changed before process spawn");
    }

    const discovery = await this.discover();
    this.#verifiedCandidates = discovery.candidates ?? [];
    const verified = this.#findVerified(selected);
    if (!verified) {
      throw new Error("Selected Codex executable identity changed before process spawn");
    }
    return verified.path;
  }

  async markStartupSuccess() {
    if (!validIdentity(this.#selection)) return;
    await this.#load();
    this.#state.active = identity(this.#selection);
    this.#state.selected = identity(this.#selection);
    this.#state.lastKnownGood = identity(this.#selection);
    this.#state.status = this.#state.status === "rollback-starting" ? "rolled-back" : "ready";
    this.#state.reason = null;
    this.#state.lastError = null;
    await this.#save();
  }

  async markStartupFailure(error) {
    if (!validIdentity(this.#selection)) return false;
    await this.#load();
    this.#state.failedIdentity = identity(this.#selection);
    this.#state.lastError = String(error?.message ?? error);
    const verifiedLkg = this.#findVerified(this.#state.lastKnownGood);
    if (!verifiedLkg || sameIdentity(verifiedLkg, this.#selection)) {
      this.#state.status = "startup-failed";
      this.#state.reason = "rollback-unavailable";
      await this.#save();
      return false;
    }
    this.#rollbackIdentity = identity(verifiedLkg);
    this.#state.status = "startup-failed-rollback-pending";
    this.#state.reason = `failed-${this.#selection.version}`;
    await this.#save();
    return true;
  }

  diagnostics() {
    return {
      policy: this.requestedExecutable
        ? "manual-override"
        : this.autoUpdateEnabled ? (this.versionPin ? "version-pin" : "automatic") : "disabled",
      versionPin: this.versionPin || null,
      status: this.#state.status,
      reason: this.#state.reason,
      active: this.#state.active,
      selected: this.#selection ?? this.#state.selected,
      candidate: this.#state.candidate,
      lastKnownGood: this.#state.lastKnownGood,
      failedIdentity: this.#state.failedIdentity,
      canary: this.#state.canary,
      rejected: this.#state.rejected ?? [],
      lastError: this.#state.lastError,
      updatedAt: this.#state.updatedAt,
    };
  }
}

export { sameIdentity as sameCodexExecutableIdentity };
