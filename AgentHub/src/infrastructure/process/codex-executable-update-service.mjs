import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isCodexBundleSignatureRejectionMessage, sameCodexBundleIdentity, validCodexBundle } from "./codex-executable-bundle.mjs";
import { acquireCodexExecutableCustody } from "./codex-executable-custody.mjs";

import {
  CODEX_CANDIDATE_MISSING,
  codexExecutableRejectionMessage,
  discoverOfficialCodexExecutables,
  isCodexExecutableSignatureRejectionMessage,
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
    ...(candidate.bundle ? { bundle: structuredClone(candidate.bundle) } : {}),
  };
}

function sameCoreIdentity(left, right) {
  return Boolean(left && right
    && String(left.path).toLowerCase() === String(right.path).toLowerCase()
    && left.version === right.version
    && left.sha256 === right.sha256
    && left.publisher === right.publisher && left.source === right.source);
}

function sameIdentity(left, right) {
  return sameCoreIdentity(left, right) && sameCodexBundleIdentity(left.bundle, right.bundle);
}

function validIdentity(value) {
  return value && typeof value === "object"
    && typeof value.path === "string" && value.path
    && typeof value.version === "string" && value.version
    && typeof value.sha256 === "string" && /^[A-F0-9]{64}$/.test(value.sha256)
    && typeof value.publisher === "string" && value.publisher
    && (value.bundle === undefined || validCodexBundle(value.bundle));
}

function unavailableRecordedIdentity(error) {
  return [CODEX_CANDIDATE_MISSING, "ENOENT", "ENOTDIR", "CODEX_BUNDLE_UNAVAILABLE"].includes(error?.code);
}

function safeToolProof(canary, candidate) {
  if (canary?.status !== "passed" || canary.evidence?.safeToolCount !== 1
    || !validIdentity(canary.identity) || !sameIdentity(canary.identity, candidate)) return null;
  return { identity: identity(candidate), status: "passed", evidence: { safeToolCount: 1 } };
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
    lastKnownGoodCanary: null,
    status: "uninitialized",
    reason: null,
    lastError: null,
    recordedSignatureRejection: null,
    updatedAt: null,
  };
}

export class CodexExecutableUpdateService {
  #loaded = false;
  #loadPromise = null;
  #state = initialState();
  #selection = null;
  #selectionCanary = null;
  #startupSelection = null;
  #verifiedCandidates = [];
  #rollbackIdentity = null;
  #savePromise = Promise.resolve();
  #refreshPromise = null;
  #backgroundTimer = null;
  #backgroundGeneration = 0;
  #selectionCustody = null;
  #recoverUnavailable = false;
  #rediscoverOnStart = false;
  #custodyReleased = Promise.resolve();

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
    acquireCustody = acquireCodexExecutableCustody,
    canRecoverUnavailableSelection = () => false,
    executableArgs = [],
    rpcTimeoutMs = 30_000,
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
      acquireCustody: bundle => acquireCustody(bundle, { timeoutMs: rpcTimeoutMs }),
      canRecoverUnavailableSelection, executableArgs,
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
      state.lastKnownGoodCanary = safeToolProof(state.lastKnownGoodCanary, state.lastKnownGood)
        ?? safeToolProof(state.canary, state.lastKnownGood);
      if (!isCodexBundleSignatureRejectionMessage(state.recordedSignatureRejection)) {
        state.recordedSignatureRejection = null;
      }
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
      // Persist the bytes before publishing their name; rename alone does not
      // flush cached data when Windows loses power.
      await this.writeFileImpl(temporary, serialized, { encoding: "utf8", flag: "wx", flush: true });
      await this.renameImpl(temporary, this.stateFile);
    } finally {
      await this.unlinkImpl(temporary).catch(() => null);
    }
  }

  #matchesPin(candidate) {
    return !this.versionPin || candidate.version === this.versionPin;
  }

  #discoverySelection(candidates, state = this.#state) {
    const allowed = candidates.filter(candidate => this.#matchesPin(candidate));
    const verifiedLkg = allowed.find(candidate => sameIdentity(candidate, state.lastKnownGood)) ?? null;
    const legacy = allowed.find(candidate => candidate.source.startsWith("vscode")) ?? null;
    return { candidate: allowed[0] ?? null, verifiedLkg, legacy };
  }

  #usablePrepared(state) {
    const candidate = state.prepared;
    return this.autoUpdateEnabled && validIdentity(candidate) && this.#matchesPin(candidate)
      && !sameIdentity(candidate, state.failedIdentity);
  }

  // Installer observation only. A positive result still requires ordinary
  // startup custody and compatibility checks after cutover.
  async inspectUpgradeReadiness() {
    if (this.requestedExecutable || this.platform !== "win32") return { status: "unchecked" };
    const state = await this.#readPersistedState({ allowMissing: true });
    const recorded = state.lastKnownGood;
    if (!validIdentity(recorded) || !this.#matchesPin(recorded)) return { status: "unchecked" };
    let missing;
    try {
      await this.#freshRecorded(recorded);
      return { status: "eligible" };
    } catch (error) {
      if (error?.code !== CODEX_CANDIDATE_MISSING) return { status: "unchecked" };
      missing = codexExecutableRejectionMessage(error);
    }
    if (this.#usablePrepared(state)) {
      const prepared = await this.#freshRecorded(state.prepared).catch(() => null);
      if (prepared) return { status: "eligible", rejection: missing };
    }
    const discovery = await this.discover(this.#discoveryOptions(state));
    const rejection = discovery.rejected?.map(entry => entry.error)
      .find(isCodexExecutableSignatureRejectionMessage) ?? missing;
    const { candidate, verifiedLkg, legacy } = this.#discoverySelection(discovery.candidates ?? [], state);
    const fallback = verifiedLkg ?? legacy;
    const compatiblePolicy = this.autoUpdateEnabled
      ? !sameIdentity(candidate, state.failedIdentity) || sameIdentity(candidate, state.active)
        || sameIdentity(candidate, verifiedLkg) || Boolean(fallback && !sameIdentity(fallback, candidate))
      : Boolean(fallback);
    if (candidate && compatiblePolicy) return { status: "eligible", rejection };
    if (discovery.inspectionComplete !== true) {
      return { status: "unchecked", reason: "inspection-incomplete", rejection };
    }
    return { status: "blocked", rejection, reason: this.versionPin ? "pin-unavailable"
      : this.autoUpdateEnabled ? "no-eligible-trusted-codex" : "automatic-update-disabled" };
  }

  #hasActiveCodexRuns() {
    return this.activeRuns().some((run) => (
      run?.provider === "codex" && !["completed", "failed", "cancelled", "aborted"].includes(run?.status)
    ));
  }

  async #select(candidate, status, reason = null, { measure, retainedCustody } = {}) {
    const previous = this.#selectionCustody;
    let lease = retainedCustody;
    let proof;
    try {
      this.#selection = identity(candidate);
      if (candidate.bundle && !lease) {
        lease = await measure("selectionCustodyMs", () => this.acquireCustody(candidate.bundle));
      }
      lease?.assertAlive();
      proof = safeToolProof(this.#state.canary, candidate) ?? safeToolProof(this.#state.lastKnownGoodCanary, candidate);
      if (candidate.bundle?.codeModeHost && !proof) {
        const startedAt = this.now().toISOString();
        const result = await measure("canaryMs", () => this.runCanary(candidate));
        if (result?.ok !== true || result.evidence?.safeToolCount !== 1) {
          throw new Error("Codex compatibility canary did not confirm safe tool execution");
        }
        lease.assertAlive();
        this.#state.canary = { identity: identity(candidate), status: "passed", startedAt,
          completedAt: this.now().toISOString(), evidence: result.evidence };
        proof = safeToolProof(this.#state.canary, candidate);
      }
      this.#state.selected = identity(candidate);
      this.#state.status = status;
      this.#state.reason = reason;
      this.#state.lastError = null;
      await measure("stateWriteMs", () => this.#save());
    } catch (error) {
      await lease?.release();
      throw error;
    }
    this.#selectionCustody = lease ? { identity: this.#selection, bound: false, lease } : null;
    this.#selectionCanary = proof;
    if (previous && !previous.bound) await previous.lease.release();
    return candidate.path;
  }

  async #freshRecorded(candidate, inspection = {}) {
    const verified = await this.verifyRecorded(candidate, { executableArgs: this.executableArgs, ...inspection });
    if (!sameCoreIdentity(candidate, verified)) throw new Error("Recorded Codex executable identity changed");
    return verified;
  }

  async #usableRecorded(candidate, { prepared = false, ...inspection } = {}) {
    try { return await this.#freshRecorded(candidate, inspection); }
    catch (error) {
      this.#state.lastError = codexExecutableRejectionMessage(error);
      if (!prepared && !unavailableRecordedIdentity(error)) {
        this.#state.status = "selection-rejected";
        this.#state.reason = "recorded-identity-unverified";
        await this.#save();
        throw error;
      }
      return null;
    }
  }

  bindSpawnedProcess(child) {
    const custody = this.#selectionCustody;
    if (!custody) return;
    custody.lease.assertAlive();
    custody.bound = true;
    const closed = new Promise(resolve => child.once("close", () => {
      void custody.lease.release().then(resolve);
      if (this.#selectionCustody === custody) this.#selectionCustody = null;
    }));
    this.#custodyReleased = Promise.all([this.#custodyReleased, closed]).then(() => {});
    return closed;
  }

  async releaseUnboundSelection() {
    const custody = this.#selectionCustody;
    if (custody && !custody.bound) {
      await custody.lease.release();
      if (this.#selectionCustody === custody) this.#selectionCustody = null;
    }
  }

  waitForCustodyRelease() { return this.#custodyReleased; }

  async selectForStart() {
    const startedAt = performance.now();
    const selection = { startedAtMs: Date.now(), phases: {} };
    if ((this.#rollbackIdentity || this.#rediscoverOnStart) && this.#startupSelection?.outcome) {
      const { startedAtMs, durationMs, outcome, phases } = this.#startupSelection;
      selection.previousAttempt = { startedAtMs, durationMs, outcome, phases: { ...phases } };
    }
    this.#startupSelection = selection;
    const measure = async (phase, work) => {
      const start = performance.now();
      try { return await work(); }
      finally { selection.phases[phase] = (selection.phases[phase] ?? 0) + Math.round(performance.now() - start); }
    };
    try {
      const command = await this.#selectForStart(measure);
      selection.outcome = "succeeded";
      return command;
    } catch (error) {
      selection.outcome = "failed";
      throw error;
    } finally {
      selection.durationMs = Math.round(performance.now() - startedAt);
    }
  }

  async #selectRecorded(candidate, { status, reason, prepared, measure }) {
    let held;
    try {
      const verified = await measure("recordedMs", () => this.#usableRecorded(candidate, {
        prepared, measure, retainCustody: custody => { held = custody; },
      }));
      if (!verified) return null;
      const outcome = typeof status === "function" ? status() : status;
      const retainedCustody = held;
      held = null;
      return await this.#select(verified, outcome, reason, { measure, retainedCustody });
    } finally {
      if (held) await measure("inspectionReleaseMs", () => held.release());
    }
  }

  async #selectForStart(measure) {
    if (this.requestedExecutable) {
      this.#selection = { path: this.requestedExecutable, version: null, sha256: null, source: "manual-override" };
      this.#state.status = "manual-override";
      this.#state.reason = "codexExecutable";
      return this.requestedExecutable;
    }
    await measure("stateReadMs", () => this.#load());
    if (this.platform !== "win32") {
      this.#selection = { path: "codex", version: null, sha256: null, source: "path-fallback" };
      this.#state.status = "path-fallback";
      this.#state.reason = "official-install-discovery-is-windows-only";
      return "codex";
    }
    if (this.#rediscoverOnStart) {
      this.#rediscoverOnStart = false;
      return this.#bootstrapSelection(measure);
    }

    if (this.#rollbackIdentity) {
      const rollback = this.#rollbackIdentity;
      this.#rollbackIdentity = null;
      if (this.#matchesPin(rollback)) {
        const command = await this.#selectRecorded(rollback, {
          status: "rollback-starting", reason: "candidate-startup-failed", measure,
        });
        if (command) return command;
      }
    }
    const prepared = this.#state.prepared;
    if (this.#usablePrepared(this.#state) && !this.#hasActiveCodexRuns()) {
      const command = await this.#selectRecorded(prepared, {
        prepared: true, status: "candidate-starting", reason: "background-verified", measure,
      });
      if (command) return command;
    }
    const lastKnownGood = this.#state.lastKnownGood;
    if (validIdentity(lastKnownGood) && this.#matchesPin(lastKnownGood)) {
      const command = await this.#selectRecorded(lastKnownGood, { measure, status: () => !this.autoUpdateEnabled ? "disabled"
        : this.#hasActiveCodexRuns() && prepared ? "deferred-active-runs"
          : this.versionPin ? "pinned" : "current" });
      if (command) return command;
      this.#recoverUnavailable = this.canRecoverUnavailableSelection() === true;
    }
    if (this.#recoverUnavailable && this.#usablePrepared(this.#state)) {
      const command = await this.#selectRecorded(prepared, {
        prepared: true, status: "candidate-starting", reason: "unavailable-recorded-bundle-recovery", measure,
      });
      if (command) return command;
    }
    return this.#bootstrapSelection(measure);
  }

  async #bootstrapSelection(measure) {
    const discover = () => measure("discoveryMs", () => this.discover({ ...this.#discoveryOptions(), measure }));
    const select = (candidate, status, reason) => this.#select(candidate, status, reason, { measure });
    const discovery = await discover();
    this.#verifiedCandidates = discovery.candidates ?? [];
    this.#state.trustedCandidates = this.#verifiedCandidates.map(identity);
    const { candidate, verifiedLkg, legacy } = this.#discoverySelection(this.#verifiedCandidates);
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
        + summarizeCodexExecutableRejections(this.#state.rejected)
        + (this.#state.recordedSignatureRejection ? `; recorded: ${this.#state.recordedSignatureRejection}` : "");
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
      return select(fallback, "disabled", "automatic-update-disabled");
    }
    if (sameIdentity(candidate, verifiedLkg) || sameIdentity(candidate, this.#state.active)) {
      return select(candidate, this.versionPin ? "pinned" : "current");
    }
    if (sameIdentity(candidate, this.#state.failedIdentity)) {
      const fallback = verifiedLkg ?? legacy;
      if (!fallback || sameIdentity(fallback, candidate)) {
        throw new Error(`Codex ${candidate.version} is blocked after a failed compatibility check`);
      }
      return select(fallback, "candidate-blocked", "failed-identity-unchanged");
    }
    if (this.#hasActiveCodexRuns() && !this.#recoverUnavailable) {
      const fallback = verifiedLkg ?? legacy;
      if (!fallback) {
        this.#state.status = "deferred-active-runs";
        this.#state.reason = "no-safe-current-identity";
        await this.#save();
        throw new Error("Codex executable update is deferred while active runs require recovery");
      }
      return select(fallback, "deferred-active-runs", `candidate-${candidate.version}`);
    }

    const startedAt = this.now().toISOString();
    try {
      const custody = candidate.bundle ? await measure("selectionCustodyMs", () => this.acquireCustody(candidate.bundle)) : null;
      let result;
      try { result = await measure("canaryMs", () => this.runCanary(candidate)); }
      finally { await custody?.release(); }
      if (result?.ok !== true) throw new Error(result?.error || "compatibility canary did not pass");
      const confirmedDiscovery = await discover();
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
      return select(confirmed, "candidate-starting", this.versionPin ? "version-pin" : "newest-installed");
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
      return select(fallback, "canary-failed-using-last-known-good", `candidate-${candidate.version}`);
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

    if (this.#selectionCustody && sameIdentity(this.#selectionCustody.identity, selected)) {
      this.#selectionCustody.lease.assertAlive();
      return selected.path;
    }
    const verified = await this.verifyRecorded(selected, { executableArgs: this.executableArgs });
    if (!sameIdentity(verified, selected)) throw new Error("Selected Codex executable identity changed before process spawn");
    return verified.path;
  }

  startBackgroundChecks({ canCheck = () => true, onPrepared = async () => {}, intervalMs = 60_000 } = {}) {
    if (this.#backgroundTimer || this.requestedExecutable || this.platform !== "win32") return;
    this.#backgroundTimer = setInterval(() => {
      const generation = this.#backgroundGeneration;
      if (canCheck()) void this.refreshInBackground().then(() => {
        if (generation !== this.#backgroundGeneration || !this.#backgroundTimer) return;
        if (this.#state.prepared && !sameIdentity(this.#state.prepared, this.#state.active)) return onPrepared();
      }).catch(() => {});
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

  #discoveryOptions(state = this.#state) {
    return { trustedCandidates: state.trustedCandidates,
      ...(this.executableArgs.length ? { executableArgs: this.executableArgs } : {}) };
  }

  async #refresh(generation) {
    if (this.requestedExecutable || this.platform !== "win32") return;
    await this.#load();
    this.#state.background = { status: "checking", startedAt: this.now().toISOString(), error: null };
    try {
      const discovery = await this.discover(this.#discoveryOptions());
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
        this.#state.background.status = this.autoUpdateEnabled && sameIdentity(candidate, this.#state.prepared)
          && !sameIdentity(candidate, this.#state.active) ? "prepared-for-next-start" : "current";
      } else if (sameIdentity(candidate, this.#state.failedIdentity)) {
        this.#state.background.status = "candidate-blocked";
      } else {
        if (this.#hasActiveCodexRuns()) {
          const repairingLostTransport = this.canRecoverUnavailableSelection() === true
            && validIdentity(this.#state.lastKnownGood)
            && await this.#usableRecorded(this.#state.lastKnownGood) === null;
          if (!repairingLostTransport) {
            this.#state.background.status = "deferred-active-runs";
            this.#state.background.completedAt = this.now().toISOString();
            await this.#save(); return;
          }
          this.#recoverUnavailable = true;
        }
        const startedAt = this.now().toISOString();
        this.#state.background.status = "canary";
        try {
          const custody = candidate.bundle ? await this.acquireCustody(candidate.bundle) : null;
          let result;
          try { result = await this.runCanary(candidate); }
          finally { await custody?.release(); }
          if (result?.ok !== true) throw new Error("Codex compatibility canary did not pass");
          const verified = await this.verifyRecorded(candidate, { executableArgs: this.executableArgs });
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
    this.#state.lastKnownGoodCanary = this.#selectionCanary;
    if (sameIdentity(this.#state.prepared, this.#selection)) this.#state.prepared = null;
    this.#state.status = this.#state.status === "rollback-starting" ? "rolled-back" : "ready";
    this.#state.reason = null;
    this.#state.lastError = null;
    this.#recoverUnavailable = false;
    await this.#save();
  }

  async markStartupFailure(error) {
    await this.releaseUnboundSelection();
    if (!validIdentity(this.#selection)) return false;
    await this.#load();
    const lost = [error, error?.cause].some(unavailableRecordedIdentity);
    if (!lost) this.#state.failedIdentity = identity(this.#selection);
    this.#state.lastError = String(error?.message ?? error);
    const verifiedLkg = this.#state.lastKnownGood;
    if (!verifiedLkg || sameCoreIdentity(verifiedLkg, this.#selection)) {
      this.#state.status = "startup-failed";
      this.#state.reason = "rollback-unavailable";
      await this.#save();
      if (lost && this.autoUpdateEnabled && !this.requestedExecutable) {
        this.#recoverUnavailable = this.canRecoverUnavailableSelection() === true;
        this.#rediscoverOnStart = true;
        // The lifecycle owns one retry. Rediscovery/canary still owns trust;
        // no command or tool invocation is retried by executable recovery.
        return true;
      }
      return false;
    }
    this.#rollbackIdentity = identity(verifiedLkg);
    this.#state.status = "startup-failed-rollback-pending";
    this.#state.reason = `failed-${this.#selection.version}`;
    await this.#save();
    return true;
  }

  diagnostics() {
    const selection = this.#startupSelection;
    const previousAttempt = selection?.previousAttempt;
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
      recordedSignatureRejection: this.#state.recordedSignatureRejection,
      startupSelection: selection ? {
        ...selection,
        phases: { ...selection.phases },
        ...(previousAttempt ? { previousAttempt: { ...previousAttempt, phases: { ...previousAttempt.phases } } } : {}),
      } : null,
      updatedAt: this.#state.updatedAt,
    };
  }
}

export { sameIdentity as sameCodexExecutableIdentity };
