import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { stopProcessTree } from "../src/infrastructure/process/process-tree.mjs";
import {
  processFingerprintMatches,
  readOwnedProcessTree,
  readProcessFingerprint,
} from "../src/providers/claude/claude-run-io.mjs";

const FAKE_MODEL = "fake-codex";
const OWN_ARGUMENTS = new Set([
  "--real-executable",
  "--fake-executable",
  "--fake-state",
  "--routing-state",
]);
const CHILD_RPC_TIMEOUT_MS = 180_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

function parsedArguments(argv) {
  const own = new Map();
  const passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (OWN_ARGUMENTS.has(current)) {
      own.set(current, String(argv[index + 1] ?? "").trim());
      index += 1;
    } else {
      passthrough.push(current);
    }
  }
  return { own, passthrough };
}

const parsed = parsedArguments(process.argv.slice(2));
const runtimeRoot = path.resolve(String(process.env.AGENT_HUB_RUNTIME_ROOT ?? ""));
const realExecutable = parsed.own.get("--real-executable") ?? "";
const fakeExecutable = path.resolve(parsed.own.get("--fake-executable") ?? "");
const fakeStateFile = path.resolve(parsed.own.get("--fake-state") ?? "");
const routingStateFile = path.resolve(parsed.own.get("--routing-state") ?? "");
const realArguments = parsed.passthrough.length > 0
  ? parsed.passthrough
  : ["app-server", "--stdio"];

function insideRuntime(candidate) {
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try { return realpathSync.native(resolved); } catch {}
    try { return path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved)); } catch {}
    return resolved;
  };
  const relative = path.relative(canonical(runtimeRoot), canonical(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

if (process.env.AGENT_HUB_TEST_CONTOUR !== "1"
  || !runtimeRoot
  || !realExecutable
  || !insideRuntime(fakeExecutable)
  || !insideRuntime(fakeStateFile)
  || !insideRuntime(routingStateFile)) {
  throw new Error("Codex multiplexer is restricted to its owned Test Contour runtime");
}

function readRoutingState() {
  if (!existsSync(routingStateFile)) return { version: 2, revision: 0, activeFakeThreadIds: [] };
  const value = JSON.parse(readFileSync(routingStateFile, "utf8"));
  if (!Array.isArray(value.activeFakeThreadIds)) throw new Error("Invalid Codex multiplexer routing state");
  return value;
}

const routingState = readRoutingState();
const activeFakeThreads = new Set(routingState.activeFakeThreadIds);
let routingRevision = Number(routingState.revision) || 0;

function saveRoutingState() {
  routingRevision += 1;
  const temporary = `${routingStateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    version: 2,
    revision: routingRevision,
    activeFakeThreadIds: [...activeFakeThreads].sort(),
  }, null, 2)}\n`, "utf8");
  renameSync(temporary, routingStateFile);
}

function startChild(command, args, environment = process.env) {
  return spawn(command, args, {
    cwd: runtimeRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    // Keep POSIX children in the multiplexer group so an external owner can
    // still terminate the whole contour if this process crashes. Normal
    // shutdown additionally verifies each exact child/descendant fingerprint.
    detached: false,
  });
}

const children = {
  real: startChild(realExecutable, realArguments),
  fake: startChild(process.execPath, [
    fakeExecutable,
    "--state",
    fakeStateFile,
    "--require-test-contour",
    "--accept-all",
    "app-server",
    "--stdio",
  ], {
    ...process.env,
    AGENT_HUB_TEST_CONTOUR_PROFILE: "fake-codex",
  }),
};

async function readFingerprintWithRetry(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const fingerprint = await readProcessFingerprint(pid);
    if (fingerprint) return fingerprint;
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

const childOwners = new Map(await Promise.all(Object.entries(children).map(async ([backend, child]) => [
  child,
  {
    backend,
    root: await readFingerprintWithRetry(child.pid),
    known: [],
  },
])));
for (const owner of childOwners.values()) {
  if (owner.root) {
    const createdAtMs = Date.parse(owner.root.creationTime);
    owner.root.startedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
    owner.known = [owner.root];
  }
}

let childRequestSequence = 1;
let serverRequestSequence = 1_000_000;
const pendingChildRequests = new Map();
const pendingServerRequests = new Map();
const closedChildren = new WeakSet();
let shuttingDown = false;
let shutdownPromise = null;

function sendClient(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendChild(backend, message) {
  children[backend].stdin.write(`${JSON.stringify(message)}\n`);
}

function childRpcError(rpcError) {
  const error = new Error(rpcError?.message ?? "Codex child RPC failed");
  error.rpcError = rpcError ?? { message: error.message };
  if (rpcError?.code !== undefined) error.code = rpcError.code;
  if (rpcError?.data !== undefined) error.data = rpcError.data;
  return error;
}

function callChild(backend, method, params = {}) {
  const id = childRequestSequence++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingChildRequests.delete(id);
      reject(childRpcError({
        code: -32098,
        message: `${backend} Codex child RPC timed out: ${method}`,
        data: { kind: "childRpcTimeout", backend, method },
      }));
    }, CHILD_RPC_TIMEOUT_MS);
    timeout.unref?.();
    pendingChildRequests.set(id, { backend, resolve, reject, timeout });
    sendChild(backend, { id, method, params });
  });
}

function messageThreadId(message = {}) {
  return String(
    message.params?.threadId
      ?? message.params?.thread?.id
      ?? message.threadId
      ?? message.thread?.id
      ?? "",
  ).trim();
}

function backendOwnsMessage(backend, message) {
  const id = messageThreadId(message);
  if (!id) return backend === "real";
  return activeFakeThreads.has(id) === (backend === "fake");
}

function forwardServerRequest(backend, message) {
  if (!backendOwnsMessage(backend, message)) return;
  const id = serverRequestSequence++;
  pendingServerRequests.set(id, { backend, childId: message.id });
  sendClient({ ...message, id });
}

function handleChildMessage(backend, message) {
  if (message?.method && message.id !== undefined) {
    forwardServerRequest(backend, message);
    return;
  }
  if (message?.id !== undefined) {
    const pending = pendingChildRequests.get(message.id);
    if (!pending) return;
    pendingChildRequests.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(childRpcError(message.error));
    else pending.resolve(message.result);
    return;
  }
  if (backendOwnsMessage(backend, message)) sendClient(message);
}

for (const [backend, child] of Object.entries(children)) {
  child.once("close", () => {
    const owner = childOwners.get(child);
    if (owner?.root) owner.root.exitedAtMs = Date.now();
    closedChildren.add(child);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      handleChildMessage(backend, JSON.parse(line));
    } catch (error) {
      process.stderr.write(`[${backend}] invalid message: ${error.message}\n`);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => process.stderr.write(`[${backend}] ${data}`));
  child.on("error", (error) => process.stderr.write(`[${backend}] failed: ${error.message}\n`));
  child.on("exit", (code, signal) => {
    for (const [requestId, pending] of pendingChildRequests) {
      if (pending.backend !== backend) continue;
      pendingChildRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(childRpcError({
        code: -32099,
        message: `${backend} Codex child exited: ${signal ?? code}`,
        data: { kind: "childExited", backend },
      }));
    }
    if (shuttingDown) return;
    process.stderr.write(`[${backend}] exited: ${signal ?? code}\n`);
    void shutdown(Number.isInteger(code) && code !== 0 ? code : 1);
  });
}

function threadId(params = {}) {
  return String(params.threadId ?? params.expectedThreadId ?? "").trim();
}

function requestedFake(params = {}) {
  return params.model === FAKE_MODEL;
}

function ownedBackend(params = {}) {
  const id = threadId(params);
  if (id) return activeFakeThreads.has(id) ? "fake" : "real";
  return requestedFake(params) ? "fake" : "real";
}

function backendChangeError(id, from, to) {
  return childRpcError({
    code: -32041,
    message: `Thread ${id} belongs to ${from}; switching to ${to} requires a new Thread`,
    data: {
      kind: "threadBackendChangeRequiresNewThread",
      threadId: id,
      currentBackend: from,
      requestedBackend: to,
    },
  });
}

function assertRequestedBackend(params = {}) {
  const id = threadId(params);
  if (!id || params.model === undefined) return;
  const current = activeFakeThreads.has(id) ? "fake" : "real";
  const requested = requestedFake(params) ? "fake" : "real";
  if (current !== requested) throw backendChangeError(id, current, requested);
}

function mergedThreadList(realResult = {}, fakeResult = {}) {
  const merged = new Map(
    (realResult.data ?? [])
      .filter((item) => !activeFakeThreads.has(item.id))
      .map((item) => [item.id, item]),
  );
  for (const item of fakeResult.data ?? []) {
    if (activeFakeThreads.has(item.id)) merged.set(item.id, item);
  }
  return { ...realResult, data: [...merged.values()] };
}

function mergedLoadedThreads(realResult = {}, fakeResult = {}) {
  const ids = new Set((realResult.data ?? []).filter((id) => !activeFakeThreads.has(id)));
  for (const id of fakeResult.data ?? []) {
    if (activeFakeThreads.has(id)) ids.add(id);
  }
  return { ...realResult, data: [...ids] };
}

async function reconcileFakeOwnership() {
  const result = await callChild("fake", "thread/list", { limit: 10_000 });
  let changed = false;
  for (const thread of result?.data ?? []) {
    const id = String(thread?.id ?? "").trim();
    if (id && !activeFakeThreads.has(id)) {
      activeFakeThreads.add(id);
      changed = true;
    }
  }
  if (changed) saveRoutingState();
}

let testContourLoginSequence = 0;

/*
 * Test Contour never forwards account sign-in to either child: the real child
 * would start a real ChatGPT login against the contour's copied auth. Sign-in is
 * answered synthetically, with a loopback link that reaches no external host.
 */
function testContourAccountLogin(method) {
  if (method === "account/login/start") {
    testContourLoginSequence += 1;
    const loginId = `test-contour-login-${process.pid}-${testContourLoginSequence}`;
    return {
      type: "chatgpt",
      loginId,
      authUrl: `https://127.0.0.1:9/agent-hub-test-contour/codex-login?loginId=${loginId}`,
    };
  }
  if (method === "account/login/cancel") return {};
  throw childRpcError({ code: -32601, message: `${method} is not available in Test Contour` });
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  try {
    if (String(method).startsWith("account/login/") || method === "account/logout") {
      sendClient({ id, result: testContourAccountLogin(method) });
      return;
    }
    if (method === "initialize") {
      const [realResult] = await Promise.all([
        callChild("real", method, params),
        callChild("fake", method, params),
      ]);
      await reconcileFakeOwnership();
      sendClient({ id, result: realResult });
      return;
    }
    if (method === "model/list") {
      const result = await callChild("real", method, params);
      // The synthetic backend owns this model; catalog discovery must expose
      // it alongside the real backend without changing real pagination.
      if (Array.isArray(result?.data) && !params.cursor) {
        const data = result.data.filter(item => (
          String(item?.model ?? item?.slug ?? item?.id ?? "") !== FAKE_MODEL
        ));
        sendClient({ id, result: { ...result, data: [...data, {
          id: FAKE_MODEL, model: FAKE_MODEL,
          displayName: "Fake Codex · Принято", hidden: false,
        }] } });
      } else {
        sendClient({ id, result });
      }
      return;
    }
    if (method === "thread/start") {
      const backend = requestedFake(params) ? "fake" : "real";
      const result = await callChild(backend, method, params);
      const createdThreadId = String(result?.thread?.id ?? "").trim();
      if (backend === "fake" && createdThreadId) {
        activeFakeThreads.add(createdThreadId);
        saveRoutingState();
      }
      sendClient({ id, result });
      return;
    }
    if (method === "thread/settings/update") {
      assertRequestedBackend(params);
      sendClient({ id, result: await callChild(ownedBackend(params), method, params) });
      return;
    }
    if (method === "turn/start") assertRequestedBackend(params);
    if (method === "thread/list") {
      const [realResult, fakeResult] = await Promise.all([
        callChild("real", method, params),
        callChild("fake", method, params),
      ]);
      sendClient({ id, result: mergedThreadList(realResult, fakeResult) });
      return;
    }
    if (method === "thread/loaded/list") {
      const [realResult, fakeResult] = await Promise.all([
        callChild("real", method, params),
        callChild("fake", method, params),
      ]);
      sendClient({ id, result: mergedLoadedThreads(realResult, fakeResult) });
      return;
    }
    if (["thread/archive", "thread/delete"].includes(method)) {
      const targetThreadId = threadId(params);
      const backend = ownedBackend(params);
      const result = await callChild(backend, method, params);
      if (backend === "fake" && activeFakeThreads.delete(targetThreadId)) saveRoutingState();
      sendClient({ id, result });
      return;
    }
    sendClient({ id, result: await callChild(ownedBackend(params), method, params) });
  } catch (error) {
    sendClient({ id, error: error.rpcError ?? { message: error.message } });
  }
}

const clientInput = createInterface({ input: process.stdin });
clientInput.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message?.method && message.id !== undefined) {
      void handleRequest(message);
      return;
    }
    if (message?.method) {
      sendChild("real", message);
      sendChild("fake", message);
      return;
    }
    if (message?.id !== undefined) {
      const pending = pendingServerRequests.get(message.id);
      if (!pending) return;
      pendingServerRequests.delete(message.id);
      sendChild(pending.backend, { ...message, id: pending.childId });
    }
  } catch (error) {
    process.stderr.write(`Invalid client message: ${error.message}\n`);
  }
});
clientInput.once("close", () => { void shutdown(); });

function waitForChildClose(child, timeoutMs = CHILD_SHUTDOWN_TIMEOUT_MS) {
  if (closedChildren.has(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", closed);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const closed = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", closed);
  });
}

async function stopOwnedChild(child) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  const owner = childOwners.get(child);
  if (!owner?.root) {
    throw new Error(`Cannot verify owned Codex ${owner?.backend ?? "unknown"} child tree ${pid}`);
  }
  const deadline = Date.now() + CHILD_SHUTDOWN_TIMEOUT_MS;
  let current = await readOwnedProcessTree(owner.root, owner.known, { rootExited: closedChildren.has(child) });
  if (!Array.isArray(current)) throw new Error(`Cannot inspect owned Codex child tree ${pid}`);
  for (const item of current) {
    if (!owner.known.some((known) => Number(known.pid) === Number(item.pid))) owner.known.push(item);
  }
  for (const target of [...current].sort((left, right) => Number(right.pid) - Number(left.pid))) {
    const targetPid = Number(target.pid);
    if (targetPid === pid && closedChildren.has(child)) continue;
    const exact = await readProcessFingerprint(targetPid);
    if (!exact || !processFingerprintMatches(target, exact)) continue;
    const remainingMs = Math.max(1, deadline - Date.now());
    // POSIX children deliberately remain in the multiplexer process group so
    // an external owner can clean them after a crash. They are therefore not
    // group leaders: stop the exact fingerprint-verified PIDs one by one.
    if (await stopProcessTree(targetPid, {
      timeoutMs: remainingMs,
      processGroup: process.platform === "win32",
    }) !== true) {
      throw new Error(`Cannot stop owned Codex child tree ${targetPid}`);
    }
  }
  while (Date.now() < deadline) {
    // A stopped child can leave the process table before its close event
    // records the exit; until then ownership is unresolved, not failed.
    current = await readOwnedProcessTree(owner.root, owner.known, { rootExited: closedChildren.has(child) });
    if (Array.isArray(current) && current.length === 0
      && (closedChildren.has(child) || await waitForChildClose(child, 20))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!Array.isArray(current)) throw new Error(`Cannot inspect owned Codex child tree ${pid}`);
  if (!closedChildren.has(child) || current.length > 0) {
    throw new Error(`Owned Codex child tree ${pid} did not terminate`);
  }
}

function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    const outcomes = await Promise.allSettled(Object.values(children).map(stopOwnedChild));
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    for (const failure of failures) process.stderr.write(`Codex child shutdown failed: ${failure.reason?.message ?? failure.reason}\n`);
    if (failures.length) {
      // Do not make a parent close look like proof that an unconfirmed child
      // tree is gone. Exact children retain this process until their owner can
      // observe or terminate them.
      process.exitCode = 1;
      return false;
    }
    process.exit(exitCode);
    return true;
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
