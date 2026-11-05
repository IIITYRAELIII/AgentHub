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
  "$code=[Convert]::FromBase64String([string]$init.source)",
  "$sha=[System.Security.Cryptography.SHA256]::Create()",
  "try {$digest=[BitConverter]::ToString($sha.ComputeHash($code)).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}",
  "if ($digest -ne [string]$init.sha256) {throw 'runtime-producer-source-changed'}",
  "$net=[System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()",
  "Add-Type -TypeDefinition ([System.Text.Encoding]::UTF8.GetString($code)) -ReferencedAssemblies @((Join-Path $net 'System.Web.Extensions.dll'),(Join-Path $net 'System.dll'))",
  "[Console]::Out.WriteLine((ConvertTo-Json -Compress @{kind='ready';nonce=$init.nonce;sourceSha256=$digest}));[Console]::Out.Flush()",
  "$sequence=0L",
  "while ($null -ne ($line=[Console]::In.ReadLine())) {",
  "  $r=ConvertFrom-Json $line;$sequence++",
  "  if ($r.nonce -ne $init.nonce -or [long]$r.sequence -ne $sequence) {throw 'runtime-producer-request-changed'}",
  "  try {",
  "    $b=ConvertFrom-Json ([string]$r.binding)",
  "    $native=[AgentHubSealedRuntimeRelease]::Retire([string]$r.root,[string]$b.root.dev,[string]$b.root.ino,[string]$b.root.birthFileTime,[string]$b.manifestSha256,[string]$b.releaseId,[bool]::Parse([string]$r.partial),[string]$r.cache)",
  "    [Console]::Out.WriteLine((ConvertTo-Json -Compress @{kind='result';nonce=$init.nonce;sequence=$sequence;native=$native}));[Console]::Out.Flush()",
  "  } catch {",
  "    [Console]::Out.WriteLine((ConvertTo-Json -Compress @{kind='error';nonce=$init.nonce;sequence=$sequence;error=([string]$_.Exception.Message)}));[Console]::Out.Flush();exit 1",
  "  }",
  "}",
].join("\n");

async function sourceProof(file) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 4n * 1024n * 1024n) throw Error("sealed-runtime-producer-source-refused");
  const bytes = await readFile(file), after = await lstat(file, { bigint: true });
  if (identity(before) !== identity(after) || BigInt(bytes.length) !== before.size) throw Error("sealed-runtime-producer-source-changed");
  return { identity: identity(before), sha256: hash(bytes), bytes };
}

class RuntimeExecutor {
  constructor(source, executable, proof, environment) {
    Object.assign(this, { source, executable, proof, nonce: randomUUID(), sequence: 0, pending: null, closing: false, fault: null });
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
            if (frame.kind !== "ready" || keys !== "kind,nonce,sourceSha256" || frame.sourceSha256 !== proof.sha256) throw Error("Native producer identity changed");
            ready = true; readyResolve(); continue;
          }
          if (!this.pending || frame.sequence !== this.pending.sequence) throw Error("Native request/reply changed");
          if (frame.kind === "error" && keys === "error,kind,nonce,sequence" && typeof frame.error === "string") {
            fail(Error("sealed-runtime-outcome-unknown:native:" + frame.error.slice(0, 4096))); continue;
          }
          if (frame.kind !== "result" || keys !== "kind,native,nonce,sequence" || typeof frame.native !== "string" || stderr.trim()) throw Error("Invalid native frame");
          const result = this.pending.validate(frame.native), pending = this.pending;
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
      this.fault ??= error; closeResolve();
    });
    child.stdin.write(JSON.stringify({ nonce: this.nonce, sha256: proof.sha256, source: proof.bytes.toString("base64") }) + "\n");
  }

  async execute(source, executable, environment, validate) {
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
    this.child.stdin.write(JSON.stringify({ nonce: this.nonce, sequence,
      root: environment.AGENT_HUB_RUNTIME_RETIRE_ROOT, binding: environment.AGENT_HUB_RUNTIME_RETIRE_BINDING,
      partial: environment.AGENT_HUB_RUNTIME_RETIRE_PARTIAL, cache: environment.AGENT_HUB_RUNTIME_RETIRE_CACHE }) + "\n");
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
  const scope = { worker: null, key: null, producer: null, proof: null, failedKeys: new Map(), busy: false, execution: null, closing: false };
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
  const scope = scopes.getStore();
  if (!scope) return null;
  if (scope.closing) return Promise.reject(Error("sealed-runtime-producer-closed"));
  if (scope.busy) return Promise.reject(Error("sealed-runtime-concurrent-batch-refused"));
  const key = JSON.stringify([environment.AGENT_HUB_RUNTIME_RETIRE_ROOT, environment.AGENT_HUB_RUNTIME_RETIRE_BINDING]);
  if (scope.failedKeys.has(key)) return Promise.reject(scope.failedKeys.get(key));
  if (scope.producer && (scope.producer.source !== source || scope.producer.executable !== executable)) return Promise.reject(Error("sealed-runtime-producer-source-changed"));
  scope.producer ??= { source, executable };
  scope.proof ??= sourceProof(source);
  scope.busy = true;
  const execution = (async () => {
    // One live producer, not a growing pool. A failed original cannot restart
    // within this scope; a different independently admitted resource may proceed.
    if (scope.worker && scope.key !== key) { await (await scope.worker).close(); scope.worker = null; }
    scope.key = key;
    scope.worker ??= scope.proof.then(proof => new RuntimeExecutor(source, executable, proof, environment));
    return (await scope.worker).execute(source, executable, environment, validate);
  })().catch(error => { scope.failedKeys.set(key, error); throw error; }).finally(() => { scope.busy = false; });
  scope.execution = execution.then(() => {}, () => {});
  return execution;
}
