import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const scopes = new AsyncLocalStorage();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const identity = info => [info.dev, info.ino, info.birthtimeNs, info.size, info.mtimeNs, info.ctimeNs, info.nlink].map(String).join(":");
const script = [
  "$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'",
  "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
  "$init=ConvertFrom-Json ([Console]::In.ReadLine())",
  "if ($init.kind -notin @('runtime','capture')) {throw 'native-producer-kind-changed'}",
  "$code=[Convert]::FromBase64String([string]$init.source)",
  "$sha=[System.Security.Cryptography.SHA256]::Create()",
  "try {$digest=[BitConverter]::ToString($sha.ComputeHash($code)).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}",
  "if ($digest -ne [string]$init.sha256) {throw 'runtime-producer-source-changed'}",
  "$net=[System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()",
  "$compileClock=[System.Diagnostics.Stopwatch]::StartNew()",
  "Add-Type -TypeDefinition ([System.Text.Encoding]::UTF8.GetString($code)) -ReferencedAssemblies @((Join-Path $net 'System.Web.Extensions.dll'),(Join-Path $net 'System.dll'))",
  "$ready=@{kind='ready';nonce=$init.nonce;sourceSha256=$digest};if ($init.kind -eq 'capture') {$ready.compileMs=$compileClock.Elapsed.TotalMilliseconds}",
  "[Console]::Out.WriteLine((ConvertTo-Json -Compress $ready));[Console]::Out.Flush()",
  "$sequence=0L",
  "while ($null -ne ($line=[Console]::In.ReadLine())) {",
  "  $r=ConvertFrom-Json $line;$sequence++",
  "  if ($r.nonce -ne $init.nonce -or [long]$r.sequence -ne $sequence) {throw 'runtime-producer-request-changed'}",
  "  $enteredCapture=$false;try {",
  "    $reply=@{kind='result';nonce=$init.nonce;sequence=$sequence}",
  "    if ($init.kind -eq 'capture') {",
  "      $b=ConvertFrom-Json ([string]$r.capture);$enteredCapture=$true",
  "      $reply.native=[AgentHubSealedNativeCapture]::Retire([string]$b.root,[string]$b.plan,[string]$b.sha256,[bool]$b.allowPartial)",
  "      $reply.timings=[AgentHubSealedNativeCapture]::LastRetirementTimings()",
  "    } else {",
  "      $b=ConvertFrom-Json ([string]$r.binding)",
  "      $reply.native=[AgentHubSealedRuntimeRelease]::Retire([string]$r.root,[string]$b.root.dev,[string]$b.root.ino,[string]$b.root.birthFileTime,[string]$b.manifestSha256,[string]$b.releaseId,[bool]::Parse([string]$r.partial),[string]$r.cache)",
  "    }",
  "    [Console]::Out.WriteLine((ConvertTo-Json -Compress $reply));[Console]::Out.Flush()",
  "  } catch {",
  "    $failure=@{kind='error';nonce=$init.nonce;sequence=$sequence;error=([string]$_.Exception.Message)}",
  "    if ($init.kind -eq 'capture') {$failure.timings='{}';if ($enteredCapture) {$failure.timings=[AgentHubSealedNativeCapture]::LastRetirementTimings()}}",
  "    [Console]::Out.WriteLine((ConvertTo-Json -Compress $failure));[Console]::Out.Flush();exit 1",
  "  }",
  "}",
].join("\n");

const captureTimingKeys = new Set(["version", "planMs", "prevalidateMs", "hashUnlinkMs", "directoryCleanupMs", "nativeMs",
  "planFiles", "planDirectories", "validatedFiles", "validatedDirectories", "hashedFiles", "hashedBytes", "unlinkedFiles"]);
function captureTimings(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096) throw Error("Invalid native timing frame");
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || Object.entries(value).some(([key, number]) => !captureTimingKeys.has(key)
      || typeof number !== "number" || !Number.isFinite(number) || number < 0)
      || value.version != null && value.version !== 1) throw Error("Invalid native timing frame");
  return value;
}

async function sourceProof(file) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 4n * 1024n * 1024n) throw Error("sealed-runtime-producer-source-refused");
  const bytes = await readFile(file), after = await lstat(file, { bigint: true });
  if (identity(before) !== identity(after) || BigInt(bytes.length) !== before.size) throw Error("sealed-runtime-producer-source-changed");
  return { identity: identity(before), sha256: hash(bytes), bytes };
}

class RuntimeExecutor {
  constructor(source, executable, proof, environment, kind) {
    Object.assign(this, { source, executable, proof, kind, nonce: randomUUID(), sequence: 0, pending: null, closing: false, fault: null,
      startedAt: performance.now(), compileMs: 0, readyAt: null, onClose: null });
    let readyResolve, readyReject, closeResolve;
    this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // A failed startup is observed by request/close, never an unhandled rejection.
    this.ready.catch(() => {});
    this.closed = new Promise(resolve => { closeResolve = resolve; });
    const child = this.child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", ready = false, spawnError;
    const decoder = new StringDecoder("utf8");
    const fail = error => {
      this.fault ??= error;
      // EOF drains the current native invocation; never kill/abort the child.
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    };
    child.stdin.on("error", error => { fail(error); });
    child.on("error", error => { spawnError = error; });
    child.stderr.on("data", chunk => {
      if (stderr.length + chunk.length > 64 * 1024) fail(Error("sealed-runtime-outcome-unknown:stderr-overflow"));
      else stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", chunk => {
      stdout += decoder.write(chunk);
      if (Buffer.byteLength(stdout, "utf8") > 64 * 1024) { stdout = ""; fail(Error("sealed-runtime-outcome-unknown:output-overflow")); return; }
      for (let newline; (newline = stdout.indexOf("\n")) >= 0;) {
        const line = stdout.slice(0, newline).replace(/\r$/u, ""); stdout = stdout.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (!frame || frame.nonce !== this.nonce || this.fault) throw Error("Unexpected native frame");
          const keys = Object.keys(frame).sort().join(",");
          if (!ready) {
            if (frame.kind !== "ready" || keys !== (kind === "capture" ? "compileMs,kind,nonce,sourceSha256" : "kind,nonce,sourceSha256")
                || frame.sourceSha256 !== proof.sha256 || kind === "capture" && (!Number.isFinite(frame.compileMs) || frame.compileMs < 0)) throw Error("Native producer identity changed");
            ready = true; this.readyAt = performance.now(); this.compileMs = frame.compileMs ?? 0; readyResolve(); continue;
          }
          if (!this.pending || frame.sequence !== this.pending.sequence) throw Error("Native request/reply changed");
          if (frame.kind === "error" && keys === (kind === "capture" ? "error,kind,nonce,sequence,timings" : "error,kind,nonce,sequence") && typeof frame.error === "string") {
            const error = Error((kind === "capture" ? "native-capture" : "sealed-runtime") + "-outcome-unknown:native:" + frame.error.slice(0, 4096));
            if (kind === "capture") error.nativeTelemetry = this.telemetry(captureTimings(frame.timings));
            fail(error); continue;
          }
          if (frame.kind !== "result" || keys !== (kind === "capture" ? "kind,native,nonce,sequence,timings" : "kind,native,nonce,sequence") || typeof frame.native !== "string" || stderr.trim()) throw Error("Invalid native frame");
          const result = this.pending.validate(frame.native), pending = this.pending;
          if (kind === "capture") result.nativeTelemetry = this.telemetry(captureTimings(frame.timings));
          this.pending = null; pending.resolve(result);
        } catch { fail(Error("sealed-runtime-outcome-unknown:invalid-result")); }
      }
    });
    child.once("close", (code, signal) => {
      this.closing = true;
      const error = this.fault ?? spawnError ?? (code !== 0 || signal || stderr.trim() || stdout.trim()
        ? Error(`sealed-runtime-outcome-unknown:${code ?? signal}:${stderr.slice(0, 4096)}`)
        : this.pending ? Error("sealed-runtime-outcome-unknown:reply-missing") : null);
      if (!ready) readyReject(error ?? Error("sealed-runtime-outcome-unknown:producer-not-ready"));
      if (this.pending) { this.pending.reject(error ?? Error("sealed-runtime-outcome-unknown:reply-missing")); this.pending = null; }
      this.fault ??= error;
      const joined = { joined: true, producerRequests: this.sequence, producerStarts: 1, sourceSha256: proof.sha256,
        producerLifetimeMs: Math.max(0, performance.now() - this.startedAt), exitCode: code, signalled: Boolean(signal), outcome: error ? "error" : "ok" };
      Promise.resolve().then(() => this.onClose?.(joined)).catch(() => {}).finally(closeResolve);
    });
    child.stdin.write(JSON.stringify({ kind, nonce: this.nonce, sha256: proof.sha256, source: proof.bytes.toString("base64") }) + "\n");
  }

  telemetry(native) {
    return { producerSequence: this.sequence, producerStarts: this.sequence === 1 ? 1 : 0, sourceSha256: this.proof.sha256,
      producerStartupMs: this.sequence === 1 ? Math.max(0, this.readyAt - this.startedAt) : 0,
      compileMs: this.sequence === 1 ? this.compileMs : 0, roundTripMs: Math.max(0, performance.now() - this.requestAt), native };
  }

  async execute(source, executable, environment, validate, onClose) {
    this.onClose = onClose;
    if (this.closing || this.fault) { await this.closed; throw this.fault ?? Error("sealed-runtime-producer-closed"); }
    await this.ready;
    if (this.closing || this.fault) { await this.closed; throw this.fault ?? Error("sealed-runtime-producer-closed"); }
    const fresh = await sourceProof(source);
    if (source !== this.source || executable !== this.executable || fresh.identity !== this.proof.identity || fresh.sha256 !== this.proof.sha256) {
      this.fault = Error("sealed-runtime-producer-source-changed"); await this.close(); throw this.fault;
    }
    if (this.closing || this.fault) { await this.closed; throw this.fault ?? Error("sealed-runtime-producer-closed"); }
    if (this.pending) throw Error("sealed-runtime-concurrent-batch-refused");
    const sequence = ++this.sequence;
    const result = new Promise((resolve, reject) => { this.pending = { sequence, validate, resolve, reject }; });
    this.drained = result.then(() => {}, () => {});
    this.requestAt = performance.now();
    this.child.stdin.write(JSON.stringify({ nonce: this.nonce, sequence,
      root: environment.AGENT_HUB_RUNTIME_RETIRE_ROOT, binding: environment.AGENT_HUB_RUNTIME_RETIRE_BINDING,
      partial: environment.AGENT_HUB_RUNTIME_RETIRE_PARTIAL, cache: environment.AGENT_HUB_RUNTIME_RETIRE_CACHE,
      ...(this.kind === "capture" ? { capture: environment.AGENT_HUB_CAPTURE_INPUT } : {}) }) + "\n");
    return result;
  }

  async close({ throwFault = false } = {}) {
    this.closing = true;
    await this.drained;
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
    await this.closed;
    if (throwFault && this.fault) throw this.fault;
  }
}

/** Resource lifetime only: callers retain every original, lease and fresh effect guard. */
export async function withSealedRuntimeExecutor(operation) {
  if (scopes.getStore()) return operation();
  const scope = { worker: null, key: null, producers: new Map(), failedKeys: new Map(), busy: false, execution: null, closing: false };
  return scopes.run(scope, async () => {
    let failed = false;
    try { return await operation(); }
    catch (error) { failed = true; throw error; }
    finally {
      scope.closing = true;
      await scope.execution;
      if (scope.worker) await (await scope.worker).close({ throwFault: !failed });
    }
  });
}

export function executeScopedRuntimeRetirement(source, executable, environment, validate) {
  return executeScopedRetirement("runtime", source, executable, environment, validate);
}

export function executeScopedCaptureRetirement(source, executable, environment, validate, onClose) {
  return executeScopedRetirement("capture", source, executable, environment, validate, onClose);
}

function executeScopedRetirement(kind, source, executable, environment, validate, onClose) {
  const scope = scopes.getStore();
  if (!scope) return null;
  if (scope.closing) return Promise.reject(Error("sealed-runtime-producer-closed"));
  if (scope.busy) return Promise.reject(Error("sealed-runtime-concurrent-batch-refused"));
  const capture = kind === "capture" ? JSON.parse(environment.AGENT_HUB_CAPTURE_INPUT) : null;
  const key = kind === "capture" ? JSON.stringify([kind, capture.root, capture.plan, capture.sha256])
    : JSON.stringify([kind, environment.AGENT_HUB_RUNTIME_RETIRE_ROOT, environment.AGENT_HUB_RUNTIME_RETIRE_BINDING]);
  if (scope.failedKeys.has(key)) return Promise.reject(scope.failedKeys.get(key));
  let producer = scope.producers.get(kind);
  if (producer && (producer.source !== source || producer.executable !== executable)) return Promise.reject(Error("sealed-runtime-producer-source-changed"));
  if (!producer) { producer = { source, executable, proof: sourceProof(source) }; scope.producers.set(kind, producer); }
  scope.busy = true;
  const execution = (async () => {
    // One live producer, not a growing pool. A failed original cannot restart
    // within this scope; a different independently admitted resource may proceed.
    if (scope.worker && scope.key !== key) { await (await scope.worker).close(); scope.worker = null; }
    scope.key = key;
    scope.worker ??= producer.proof.then(proof => new RuntimeExecutor(source, executable, proof, environment, kind));
    return (await scope.worker).execute(source, executable, environment, validate, onClose);
  })().catch(error => { scope.failedKeys.set(key, error); throw error; }).finally(() => { scope.busy = false; });
  scope.execution = execution.then(() => {}, () => {});
  return execution;
}
