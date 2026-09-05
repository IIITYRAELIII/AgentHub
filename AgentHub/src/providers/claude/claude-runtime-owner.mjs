import { spawn } from "node:child_process";
import path from "node:path";

const OWNER_PROBE_CACHE_MS = 5_000;
const OWNER_PROBE_TIMEOUT_MS = 5_000;
const OWNER_PROBE_OUTPUT_LIMIT = 64 * 1024;
const OWNER_PROBE_MAX_OWNERS = 128;
const AGENT_HUB_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const PROBE_ERROR_MESSAGES = Object.freeze({
  CLAUDE_OWNER_PROBE_EXIT: "Claude process inventory is temporarily unavailable.",
  CLAUDE_OWNER_PROBE_OUTPUT_LIMIT: "Claude process inventory exceeded its safe output limit.",
  CLAUDE_OWNER_PROBE_SCHEMA: "Claude process inventory returned an invalid result.",
  CLAUDE_OWNER_PROBE_TIMEOUT: "Claude process inventory timed out.",
  CLAUDE_OWNER_PROBE_UNAVAILABLE: "Claude process inventory could not be started.",
});
const HELPER_ERROR_CODES = new Set([
  "enumeration-unavailable",
  "argv-parser-unavailable",
  "owner-limit-exceeded",
  "runtime-signature-unresolved",
]);

export const CLAUDE_EXTERNAL_OWNER_ACTIVE = "ERR_CLAUDE_EXTERNAL_OWNER_ACTIVE";
export const CLAUDE_EXTERNAL_OWNER_UNKNOWN = "ERR_CLAUDE_EXTERNAL_OWNER_UNKNOWN";

function probeError(code) {
  const error = new Error(PROBE_ERROR_MESSAGES[code] ?? PROBE_ERROR_MESSAGES.CLAUDE_OWNER_PROBE_UNAVAILABLE);
  error.code = code;
  return error;
}

function ownerBarrierError(runtime) {
  const active = runtime?.known === true && runtime?.hasLiveProcess === true;
  const error = new Error(active
    ? "Claude external owner is active."
    : "Claude external owner could not be verified.");
  error.code = active ? CLAUDE_EXTERNAL_OWNER_ACTIVE : CLAUDE_EXTERNAL_OWNER_UNKNOWN;
  error.processEvidence = {
    complete: runtime?.complete === true,
    generation: runtime?.generation ?? null,
    scannedAt: runtime?.scannedAt ?? null,
    requestedAfterMs: runtime?.requestedAfterMs ?? 0,
  };
  return error;
}

function powershellExecutable(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runtimeSignature(invocation = {}) {
  const command = String(invocation.command ?? "claude");
  const prefixArgs = Array.isArray(invocation.prefixArgs)
    ? invocation.prefixArgs.map((value) => String(value))
    : [];
  return Buffer.from(JSON.stringify({
    command,
    prefixArgs,
    authoritative: path.isAbsolute(command)
      || prefixArgs.length > 0
      || path.basename(command).toLowerCase() === "claude.exe",
  }), "utf8").toString("base64");
}

function validateProcessSnapshot(value, generation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw probeError("CLAUDE_OWNER_PROBE_SCHEMA");
  if (typeof value.complete !== "boolean"
    || !Number.isSafeInteger(value.generation)
    || value.generation !== generation
    || !Number.isSafeInteger(value.unreadableCandidateCount)
    || value.unreadableCandidateCount < 0
    || !Array.isArray(value.owners)
    || value.owners.length > OWNER_PROBE_MAX_OWNERS
    || (value.complete && value.unreadableCandidateCount !== 0)
    || (value.complete && value.errorCode != null)
    || !Number.isFinite(Date.parse(String(value.scannedAt ?? "")))) {
    throw probeError("CLAUDE_OWNER_PROBE_SCHEMA");
  }
  const owners = value.owners.map((owner) => {
    const pid = Number(owner?.pid);
    const sessionId = String(owner?.sessionId ?? "").trim();
    const startTime = owner?.startTime == null ? null : String(owner.startTime);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !SESSION_ID_PATTERN.test(sessionId)
      || (startTime !== null && !Number.isFinite(Date.parse(startTime)))) {
      throw probeError("CLAUDE_OWNER_PROBE_SCHEMA");
    }
    return { pid, ...(startTime ? { startTime } : {}), sessionId };
  });
  if (value.errorCode != null && !HELPER_ERROR_CODES.has(value.errorCode)) {
    throw probeError("CLAUDE_OWNER_PROBE_SCHEMA");
  }
  const exactOwners = [...new Map(owners.map((owner) => [
    `${owner.pid}\0${owner.sessionId}`,
    owner,
  ])).values()];
  return Object.freeze({
    complete: value.complete,
    generation,
    scannedAt: new Date(value.scannedAt).toISOString(),
    owners: Object.freeze(exactOwners),
    unreadableCandidateCount: value.unreadableCandidateCount,
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
  });
}

export function claudeSessionProcessState(snapshot, { sessionId, agentHubPid = null } = {}) {
  const exactSessionId = String(sessionId ?? "").trim();
  const owners = (snapshot?.owners ?? []).filter((owner) => (
    owner.sessionId === exactSessionId && Number(owner.pid) !== Number(agentHubPid)
  ));
  if (snapshot?.complete !== true) {
    return { hasLiveProcess: true, known: false, complete: false, owners: [] };
  }
  return { hasLiveProcess: owners.length > 0, known: true, complete: true, owners };
}

export function readWindowsClaudeProcessSnapshot({
  agentHubPid = null,
  invocation = { command: "claude", prefixArgs: [] },
  generation = 1,
  spawnImpl = spawn,
  environment = process.env,
  timeoutMs = OWNER_PROBE_TIMEOUT_MS,
  outputLimit = OWNER_PROBE_OUTPUT_LIMIT,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(powershellExecutable(environment), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", path.join(AGENT_HUB_ROOT, "claude-session-processes.ps1"),
        "-Generation", String(generation),
        "-AgentHubPid", String(Number(agentHubPid) || 0),
        "-RuntimeSignature", runtimeSignature(invocation),
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      });
    } catch {
      reject(probeError("CLAUDE_OWNER_PROBE_UNAVAILABLE"));
      return;
    }
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const fail = (code, { kill = false } = {}) => finish(() => {
      if (kill) {
        try { child.kill(); } catch {}
      }
      reject(probeError(code));
    });
    timer = setTimeout(() => fail("CLAUDE_OWNER_PROBE_TIMEOUT", { kill: true }), timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") + stderrBytes > outputLimit) {
        fail("CLAUDE_OWNER_PROBE_OUTPUT_LIMIT", { kill: true });
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (Buffer.byteLength(stdout, "utf8") + stderrBytes > outputLimit) {
        fail("CLAUDE_OWNER_PROBE_OUTPUT_LIMIT", { kill: true });
      }
    });
    child.once("error", () => fail("CLAUDE_OWNER_PROBE_UNAVAILABLE"));
    child.once("close", (code) => finish(() => {
      if (code !== 0) {
        reject(probeError("CLAUDE_OWNER_PROBE_EXIT"));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim() || "{}");
      } catch {
        reject(probeError("CLAUDE_OWNER_PROBE_SCHEMA"));
        return;
      }
      try {
        resolve(validateProcessSnapshot(parsed, generation));
      } catch (error) {
        reject(error?.code ? error : probeError("CLAUDE_OWNER_PROBE_SCHEMA"));
      }
    }));
  });
}

export class ClaudeRuntimeOwner {
  constructor({
    agentHubPid = process.pid,
    invocation = { command: "claude", prefixArgs: [] },
    platform = process.platform,
    now = Date.now,
    cacheMs = OWNER_PROBE_CACHE_MS,
    probe = readWindowsClaudeProcessSnapshot,
  } = {}) {
    this.agentHubPid = agentHubPid;
    this.invocation = invocation;
    this.platform = platform;
    this.now = now;
    this.cacheMs = cacheMs;
    this.probe = probe;
    this.generation = 0;
    this.cached = null;
    this.inFlight = null;
  }

  async snapshot({ forceFresh = false, notBeforeMs = 0 } = {}) {
    if (this.platform !== "win32") return null;
    const requestedAfterMs = Math.max(0, Number(notBeforeMs) || 0);
    if (!forceFresh && this.cached && this.now() - this.cached.completedAtMs < this.cacheMs) {
      return this.cached.value;
    }
    while (this.inFlight) {
      if (!forceFresh) return this.inFlight.promise;
      await this.inFlight.promise.catch(() => null);
    }

    const startedAtMs = this.now();
    const generation = ++this.generation;
    const pending = Promise.resolve(this.probe({
      agentHubPid: this.agentHubPid,
      invocation: this.invocation,
      generation,
    })).catch((error) => Object.freeze({
      complete: false,
      generation,
      scannedAt: new Date(startedAtMs).toISOString(),
      owners: Object.freeze([]),
      unreadableCandidateCount: 0,
      errorCode: PROBE_ERROR_MESSAGES[error?.code] ? error.code : "CLAUDE_OWNER_PROBE_UNAVAILABLE",
    })).then((value) => {
      const boundValue = Object.freeze({ ...value, requestedAfterMs });
      this.cached = { value: boundValue, startedAtMs, requestedAfterMs, completedAtMs: this.now() };
      return boundValue;
    });
    this.inFlight = { promise: pending, startedAtMs, generation };
    try {
      return await pending;
    } finally {
      if (this.inFlight?.promise === pending) this.inFlight = null;
    }
  }

  async state(snapshot, options = {}) {
    const sessionId = String(snapshot?.sessionId ?? "").trim();
    if (this.platform !== "win32" || !SESSION_ID_PATTERN.test(sessionId)) {
      return { hasLiveProcess: true, known: false, complete: false };
    }
    const inventory = await this.snapshot(options);
    const state = claudeSessionProcessState(inventory, { sessionId, agentHubPid: this.agentHubPid });
    return {
      ...state,
      generation: inventory?.generation ?? null,
      scannedAt: inventory?.scannedAt ?? null,
      unreadableCandidateCount: inventory?.unreadableCandidateCount ?? 0,
      requestedAfterMs: inventory?.requestedAfterMs ?? 0,
      ...(inventory?.errorCode ? { errorCode: inventory.errorCode } : {}),
    };
  }

  async authorize(target) {
    const sessionId = String(target?.threadId ?? target?.sessionId ?? "").trim();
    const notBeforeMs = this.now();
    const runtime = await this.state({ sessionId }, { forceFresh: true, notBeforeMs });
    const scannedAtMs = Date.parse(String(runtime?.scannedAt ?? ""));
    if (runtime?.known !== true
      || runtime.hasLiveProcess === true
      || runtime.complete !== true
      || !Number.isSafeInteger(runtime.generation)
      || runtime.requestedAfterMs !== notBeforeMs
      || !Number.isFinite(scannedAtMs)
      || scannedAtMs < notBeforeMs) {
      throw ownerBarrierError(runtime);
    }
    return Object.freeze({
      sessionId,
      generation: runtime.generation,
      scannedAt: runtime.scannedAt,
      requestedAfterMs: runtime.requestedAfterMs,
    });
  }

  reset() {
    this.cached = null;
    this.inFlight = null;
  }
}

export class ClaudeRunAdmissionGate {
  #runtimeOwner;
  #launches = new WeakMap();

  constructor({ runtimeOwner } = {}) {
    if (typeof runtimeOwner?.authorize !== "function") {
      throw new TypeError("Claude runtime owner is required");
    }
    this.#runtimeOwner = runtimeOwner;
  }

  async prepare(target) {
    if (String(target?.provider ?? "").trim().toLowerCase() !== "claude") return null;
    const proof = await this.#runtimeOwner.authorize(target);
    let committed = false;
    return Object.freeze({
      commit: (run) => {
        if (committed
          || String(run?.provider ?? "").trim().toLowerCase() !== "claude"
          || String(run?.threadId ?? "").trim() !== proof.sessionId) {
          throw ownerBarrierError(null);
        }
        committed = true;
        run.externalOwnerProof = proof;
        this.#launches.set(run, { proof, state: "prepared" });
      },
    });
  }

  stageLaunch(run) {
    if (String(run?.provider ?? "").trim().toLowerCase() !== "claude") return true;
    const launch = this.#launches.get(run);
    if (!this.#valid(run, launch) || launch.state !== "prepared") {
      throw ownerBarrierError(null);
    }
    const ticket = Object.freeze({});
    launch.state = "staged";
    launch.ticket = ticket;
    return ticket;
  }

  consumeLaunch(run, expectedProvider = "claude", ticket = null) {
    const launch = this.#launches.get(run);
    if (expectedProvider !== "claude" || String(run?.provider ?? "").trim() !== expectedProvider) {
      throw ownerBarrierError(null);
    }
    if (!this.#valid(run, launch) || launch.state !== "staged" || launch.ticket !== ticket) {
      throw ownerBarrierError(null);
    }
    // Foreign, missing and replayed evidence is observational only: it cannot
    // revoke a legitimate staged capability. Only this exact provider/run/ticket
    // tuple may mutate the launch record at the provider-effect boundary.
    // Consumption is synchronous and terminal. Provider rejection, a thrown
    // launch dependency, completion and concurrent callers must never make the
    // same capability reusable for a second external effect.
    launch.state = "consumed";
    launch.ticket = null;
    return true;
  }

  abortLaunch(run, ticket) {
    const launch = this.#launches.get(run);
    if (launch?.state === "staged" && launch.ticket === ticket) this.#revokeStaged(launch);
    return true;
  }

  revoke(run) {
    const launch = this.#launches.get(run);
    if (launch) {
      launch.state = "revoked";
      launch.ticket = null;
    }
    return true;
  }

  #valid(run, launch) {
    const proof = launch?.proof;
    return Boolean(proof
      && run.externalOwnerProof === proof
      && proof.sessionId === String(run?.threadId ?? "").trim()
      && !["consumed", "revoked"].includes(launch.state)
      && Number.isSafeInteger(proof.generation)
      && Number.isFinite(Date.parse(String(proof.scannedAt ?? "")))
      && Number.isSafeInteger(proof.requestedAfterMs));
  }

  #revokeStaged(launch) {
    if (launch?.state !== "staged") return;
    launch.state = "revoked";
    launch.ticket = null;
  }
}

let defaultOwner = null;

export async function claudeExternalRuntimeState(snapshot, options = {}) {
  if (options.probe || options.platform || options.now || options.invocation || options.agentHubPid != null) {
    const owner = new ClaudeRuntimeOwner(options);
    return owner.state(snapshot, options);
  }
  defaultOwner ||= new ClaudeRuntimeOwner();
  return defaultOwner.state(snapshot, options);
}

export function resetClaudeRuntimeOwnerCache() {
  defaultOwner?.reset();
  defaultOwner = null;
}
