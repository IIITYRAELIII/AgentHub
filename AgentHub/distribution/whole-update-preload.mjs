// Explicitly hash-bound in a private native acceptance marker. This controls
// external transport and real I/O scheduling, never a product state result.
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, writeFileSync } from "node:fs";

const main = process.argv[1]?.endsWith("agent-hub-main.mjs");
if (main || process.argv[1]?.endsWith("runtime-package-handoff.mjs")) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const controlFile = path.join(directory, "control.json");
  const control = JSON.parse(await fs.readFile(controlFile, "utf8"));
  if ((main || process.env.AGENT_HUB_RUNTIME_ROOT) && path.resolve(process.env.AGENT_HUB_RUNTIME_ROOT) !== path.resolve(control.root)) throw Error("Foreign acceptance runtime");
  const originalFetch = globalThis.fetch;
  const providerExecutable = value => /^(?:claude|codex)(?:\.exe|\.cmd)?$/iu.test(path.basename(String(value)));
  const providerModule = value => /[\\/]@(?:anthropic-ai|openai)[\\/](?:claude-code|codex)[\\/]/iu.test(String(value));
  for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = childProcess[method];
    const wrapped = function (command, ...args) {
      const argv = Array.isArray(args[0]) ? args[0] : [], name = path.basename(String(command)).toLowerCase();
      if (control.installFailurePath && method === "execFile" && /^python(?:\.exe)?$/u.test(name)
        && argv.includes("--archive") && !argv.includes("--inspect-package")) {
        if (path.dirname(control.installFailurePath) !== path.join(control.root, "releases")) throw Error("Foreign failure fixture");
        // Real filesystem refusal inside the unmodified, hash-bound installer.
        // No fabricated exit/result; the old current and its files stay intact.
        writeFileSync(control.installFailurePath, "owned obstructing target path", { flag: "wx" });
        appendFileSync(path.join(directory, "installer-fault.jsonl"), JSON.stringify({ pid: process.pid,
          path: control.installFailurePath, at: Date.now() }) + "\n");
      }
      const shellCommand = name === "cmd.exe" ? argv.slice(argv.findIndex(value => String(value).toLowerCase() === "/c") + 1).join(" ") : "";
      if (providerExecutable(command) || (/^node(?:\.exe)?$/u.test(name) && argv.some(providerModule))
        || /(?:^|[\\/"\s])(?:claude|codex)(?:\.exe|\.cmd)?(?:$|["\s])/iu.test(shellCommand)) {
        const flags = (Array.isArray(args[0]) ? args[0] : []).map(value => /^[a-zA-Z_-]+$/u.test(String(value)) ? value : "[value]");
        // The external provider boundary is fail-closed. Never return a fake
        // product result or silently fall back to the installed account CLI.
        appendFileSync(path.join(directory, "provider-refusals.jsonl"), JSON.stringify({ pid: process.pid,
          method, command: path.basename(String(command)), flags, caller: new Error().stack.split("\n").slice(2, 8), at: Date.now() }) + "\n");
        throw Object.assign(Error("Isolated acceptance forbids real provider executable"), { code: "EACCES" });
      }
      return original.call(this, command, ...args);
    };
    if (method === "execFile") wrapped[promisify.custom] = (...args) => {
      let child;
      const promise = new Promise((resolve, reject) => { child = wrapped(...args,
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })); });
      promise.child = child; return promise;
    };
    childProcess[method] = wrapped;
  }
  syncBuiltinESMExports();
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(`${control.telegramApiBaseUrl}/`)) return originalFetch(url, options);
    if (String(url) !== control.metadataUrl) throw Error(`Unexpected acceptance network URL: ${url}`);
    const response = await originalFetch(`${control.transport}/metadata`, options);
    await fs.appendFile(path.join(directory, "transport.jsonl"), JSON.stringify({ pid: process.pid, entry: path.basename(process.argv[1]), url: String(url), at: Date.now() }) + "\n");
    return response;
  };
  if (main) {
  const temporary = path.join(path.dirname(control.root), "temp");
  if (control.temporaryRoot !== temporary || await fs.realpath(temporary) !== temporary
    || !(await fs.lstat(temporary)).isDirectory() || (await fs.lstat(temporary)).isSymbolicLink()) throw Error("Foreign acceptance scratch");
  // The declared stopped-backup destination must be outside runtimeRoot.
  // This is the test-owned sibling created by the harness, never ambient TEMP.
  process.env.TEMP = temporary; process.env.TMP = temporary;
  const release = path.dirname(process.argv[1]);
  const { withInterprocessLocks } = await import(pathToFileURL(path.join(release, "src/infrastructure/process/interprocess-lock.mjs")));
  const { prepareWindowsLockDirectoryPublisher } = await import(pathToFileURL(path.join(release, "src/infrastructure/process/windows-lock-directory-publication.mjs")));
  const originalRead = fs.readdir;
  let scans = 0, active = false;
  fs.readdir = async (...args) => {
    if (active || path.resolve(String(args[0])) !== path.join(control.root, "data")
      || !new Error().stack.includes("runtime-maintenance-backup.mjs")) return originalRead(...args);
    const latest = JSON.parse(await fs.readFile(controlFile, "utf8"));
    if (!latest.churn) return originalRead(...args);
    scans++;
    if (scans === 1) return originalRead(...args); // Intake succeeds; controller owns the failed attempt.
    active = true;
    const publisher = await prepareWindowsLockDirectoryPublisher();
    const originalPublish = publisher.publish;
    const arrived = Promise.withResolvers(), publishNow = Promise.withResolvers();
    const acquired = Promise.withResolvers(), releaseNow = Promise.withResolvers();
    const target = path.join(control.root, "data", "whole-update-transient.sqlite");
    let ready;
    publisher.publish = async function (from, to) {
      if (to === `${target}.lock`) { ready = from; arrived.resolve(); await publishNow.promise; }
      return originalPublish.call(this, from, to);
    };
    const work = withInterprocessLocks([target], async () => { acquired.resolve(); await releaseNow.promise; });
    const joined = work.then(() => null, error => error);
    try {
      await Promise.race([arrived.promise, joined.then(error => { throw error; })]);
      const names = await originalRead(...args);
      if (!names.some(name => (typeof name === "string" ? name : name.name) === path.basename(ready))) throw Error("Real ready entry not enumerated");
      publishNow.resolve(); await acquired.promise; releaseNow.resolve();
      const failure = await joined; if (failure) throw failure;
      try { await fs.lstat(ready); throw Error("Producer did not retire ready path"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (latest.churn === "replacement" && scans === 2) {
        await fs.mkdir(ready); await fs.writeFile(path.join(ready, "foreign-state.json"), "owned negative fixture");
        await fs.writeFile(path.join(directory, "replacement.json"), JSON.stringify({ ready }));
      }
      await fs.appendFile(path.join(directory, "churn.jsonl"), JSON.stringify({ pid: process.pid, scans, ready, mode: latest.churn, at: Date.now() }) + "\n");
      return names;
    } finally {
      publishNow.resolve(); releaseNow.resolve(); await joined;
      publisher.publish = originalPublish; active = false;
    }
  };
  syncBuiltinESMExports();
  }
}
