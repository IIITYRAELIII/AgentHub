import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  codexExecutableRejectionMessage,
  discoverOfficialCodexExecutables,
  summarizeCodexExecutableRejections,
  verifyRecordedCodexExecutable,
} from "./codex-executable.mjs";

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
    prepared: null,
    trustedCandidates: [],
    background: null,
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
  #loadPromise = null;
  #state = initialState();
  #selection = null;
  #verifiedCandidates = [];
  #rollbackIdentity = null;
  #savePromise = Promise.resolve();
  #refreshPromise = null;
  #backgroundTimer = null;
  #backgroundGeneration = 0;

  constructor({
    stateFile,
    requestedExecutable = "",
    autoUpdateEnabled = true,
    versionPin = "",
    discover = discoverOfficialCodexExecutables,
    verifyRecorded = verifyRecordedCodexExecutable,
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
      verifyRecorded,
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
    if (!this.#loadPromise) this.#loadPromise = this.#readPersistedState({ allowMissing: true }).then((state) => {
      this.#state = state;
      this.#loaded = true;
    }).finally(() => { this.#loadPromise = null; });
    await this.#loadPromise;
  }

  async #readPersistedState({ allowMissing }) {
    try {
      const parsed = JSON.parse(await this.readFileImpl(this.stateFile, "utf8"));
      if (parsed?.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported schema version");
      for (const key of ["active", "selected", "lastKnownGood", "candidate", "prepared", "failedIdentity"]) {
        if (parsed[key] != null && !validIdentity(parsed[key])) throw new Error(`invalid ${key} identity`);
      }
      if (parsed.trustedCandidates != null && (!Array.isArray(parsed.trustedCandidates)
        || parsed.trustedCandidates.some((entry) => !validIdentity(entry)))) throw new Error("invalid trusted identities");
      const state = { ...initialState(), ...parsed };
      for (const candidate of [state.lastKnownGood, state.prepared]) {
        if (candidate && !state.trustedCandidates.some((entry) => sameIdentity(entry, candidate))) {
          state.trustedCandidates.push(identity(candidate));
        }
      }
      return state;
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return initialState();
      throw new Error(`Cannot read Codex executable state: ${error.message}`);
    }
  }

  async #save() {
    this.#state.updatedAt = this.now().toISOString();
    const serialized = `${JSON.stringify(this.#state, null, 2)}\n`;
    const save = this.#savePromise.then(() => this.#writeState(serialized));
    this.#savePromise = save.catch(() => {});
    return save;
  }

  async #writeState(serialized) {
    const directory = path.dirname(this.stateFile);
    const temporary = path.join(directory, `.${path.basename(this.stateFile)}.${randomUUID()}.tmp`);
    await this.mkdirImpl(directory, { recursive: true });
    try {
      await this.writeFileImpl(temporary, serialized, "utf8");
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

    if (this.#rollbackIdentity) {
      const rollback = this.#rollbackIdentity;
      this.#rollbackIdentity = null;
      return this.#select(rollback, "rollback-starting", "candidate-startup-failed");
    }
    const prepared = this.#state.prepared;
    if (this.autoUpdateEnabled && validIdentity(prepared)
      && (!this.versionPin || prepared.version === this.versionPin)
      && !sameIdentity(prepared, this.#state.failedIdentity) && !this.#hasActiveCodexRuns()) {
      return this.#select(prepared, "candidate-starting", "background-verified");
    }
    const lastKnownGood = this.#state.lastKnownGood;
    if (validIdentity(lastKnownGood) && (!this.versionPin || lastKnownGood.version === this.versionPin)) {
      return this.#select(lastKnownGood, !this.autoUpdateEnabled ? "disabled"
        : this.#hasActiveCodexRuns() && prepared ? "deferred-active-runs"
          : this.versionPin ? "pinned" : "current");
    }
    return this.#bootstrapSelection();
  }

  async #bootstrapSelection() {
    const discovery = await this.discover({ trustedCandidates: this.#state.trustedCandidates });
    this.#verifiedCandidates = discovery.candidates ?? [];
    this.#state.trustedCandidates = this.#verifiedCandidates.map(identity);
    let candidates = this.#verifiedCandidates;
    if (this.versionPin) candidates = candidates.filter((candidate) => candidate.version === this.versionPin);
    const candidate = candidates[0] ?? null;
    const verifiedLkg = this.#findVerified(this.#state.lastKnownGood);
    const legacy = this.#legacyVscodeCandidate(this.#verifiedCandidates);
    this.#state.candidate = identity(candidate ?? this.#verifiedCandidates[0] ?? null);
    this.#state.rejected = (discovery.rejected ?? []).map((entry) => ({
      path: entry.path,
      source: entry.source,
      error: codexExecutableRejectionMessage(entry.error),
    }));

    if (!candidate) {
      this.#state.status = this.versionPin ? "pin-unavailable" : "no-trusted-candidate";
      this.#state.reason = this.versionPin || null;
      this.#state.lastError = (this.versionPin
        ? `No trusted installed Codex executable matches pin ${this.versionPin}`
        : "No trusted installed official Codex executable was found")
        + summarizeCodexExecutableRejections(this.#state.rejected);
      await this.#save();
      throw new Error(this.#state.lastError);
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
      const confirmedDiscovery = await this.discover({ trustedCandidates: this.#state.trustedCandidates });
      const confirmedCandidates = confirmedDiscovery.candidates ?? [];
      const confirmed = confirmedCandidates.find((entry) => sameIdentity(entry, candidate));
      if (!confirmed) throw new Error("Codex executable identity changed after compatibility canary");
      this.#verifiedCandidates = confirmedCandidates;
      this.#state.trustedCandidates = confirmedCandidates.map(identity);
      this.#state.rejected = (confirmedDiscovery.rejected ?? []).map((entry) => ({
        path: entry.path,
        source: entry.source,
        error: codexExecutableRejectionMessage(entry.error),
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

    const verified = await this.verifyRecorded(selected);
    if (!sameIdentity(verified, selected)) throw new Error("Selected Codex executable identity changed before process spawn");
    return verified.path;
  }

  startBackgroundChecks({ canCheck = () => true, intervalMs = 60_000 } = {}) {
    if (this.#backgroundTimer || this.requestedExecutable || this.platform !== "win32") return;
    this.#backgroundTimer = setInterval(() => {
      if (canCheck()) void this.refreshInBackground().catch(() => {});
    }, intervalMs);
    this.#backgroundTimer.unref?.();
  }

  stopBackgroundChecks() {
    clearInterval(this.#backgroundTimer);
    this.#backgroundTimer = null;
    this.#backgroundGeneration += 1;
  }

  refreshInBackground() {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#refresh(this.#backgroundGeneration).finally(() => { this.#refreshPromise = null; });
    return this.#refreshPromise;
  }

  async #refresh(generation) {
    if (this.requestedExecutable || this.platform !== "win32") return;
    await this.#load();
    this.#state.background = { status: "checking", startedAt: this.now().toISOString(), error: null };
    try {
      const discovery = await this.discover({ trustedCandidates: this.#state.trustedCandidates });
      if (generation !== this.#backgroundGeneration) return;
      this.#state.trustedCandidates = (discovery.candidates ?? []).map(identity);
      this.#state.rejected = (discovery.rejected ?? []).map((entry) => ({
        path: entry.path, source: entry.source, error: codexExecutableRejectionMessage(entry.error),
      }));
      const candidate = this.#state.trustedCandidates.find((entry) => !this.versionPin || entry.version === this.versionPin);
      this.#state.candidate = candidate ?? null;
      if (!candidate) throw new Error("No trusted installed official Codex executable was found");
      if (!this.autoUpdateEnabled || sameIdentity(candidate, this.#state.lastKnownGood)
        || sameIdentity(candidate, this.#state.prepared)) {
        this.#state.background.status = "current";
      } else if (sameIdentity(candidate, this.#state.failedIdentity)) {
        this.#state.background.status = "candidate-blocked";
      } else if (this.#hasActiveCodexRuns()) {
        this.#state.background.status = "deferred-active-runs";
      } else {
        const startedAt = this.now().toISOString();
        this.#state.background.status = "canary";
        try {
          const result = await this.runCanary(candidate);
          if (result?.ok !== true) throw new Error("Codex compatibility canary did not pass");
          const verified = await this.verifyRecorded(candidate);
          if (!sameIdentity(verified, candidate)) throw new Error("Codex executable identity changed after compatibility canary");
          if (generation !== this.#backgroundGeneration) return;
          this.#state.canary = { identity: identity(candidate), status: "passed", startedAt,
            completedAt: this.now().toISOString(), evidence: result.evidence ?? null };
          this.#state.prepared = identity(candidate);
          this.#state.background.status = "prepared-for-next-start";
        } catch (error) {
          if (generation !== this.#backgroundGeneration) return;
          this.#state.failedIdentity = identity(candidate);
          this.#state.canary = { identity: identity(candidate), status: "failed", startedAt,
            completedAt: this.now().toISOString(), error: "Background Codex compatibility check failed" };
          throw new Error("Background Codex compatibility check failed");
        }
      }
    } catch (error) {
      if (generation !== this.#backgroundGeneration) return;
      this.#state.background.status = "failed";
      this.#state.background.error = "Background Codex executable check failed";
    }
    if (generation !== this.#backgroundGeneration) return;
    this.#state.background.completedAt = this.now().toISOString();
    await this.#save();
  }

  async markStartupSuccess() {
    if (!validIdentity(this.#selection)) return;
    await this.#load();
    this.#state.active = identity(this.#selection);
    this.#state.selected = identity(this.#selection);
    this.#state.lastKnownGood = identity(this.#selection);
    if (sameIdentity(this.#state.prepared, this.#selection)) this.#state.prepared = null;
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
    const verifiedLkg = this.#state.lastKnownGood;
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
      prepared: this.#state.prepared,
      background: this.#state.background,
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
