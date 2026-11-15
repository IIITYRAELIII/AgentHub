import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import path from "node:path";

const [mode, target, moduleUrl] = process.argv.slice(2);
const canonical = `${target}.lock`;
process.on("message", () => {});
const originalOpen = fs.open;
const originalExecFile = childProcess.execFile;
let publicationBarrierUsed = false;
let nativeInvocations = 0;

async function checkpoint(data, resume = false) {
  process.send({ kind: "checkpoint", pid: process.pid, ...data });
  await new Promise((resolve) => { if (resume) process.once("message", resolve); });
}

// Transparent barriers around real filesystem operations. The real owner
// supplies its PID, token and bytes; no liveness/identity port is replaced.
fs.open = async (...args) => {
  const file = String(args[0]);
  if (args[1] === "r+" && path.dirname(file) === canonical) {
    if (mode === "after-publish") await checkpoint({ file });
    if (mode === "after-publish-swap") await checkpoint({ file }, true);
  }
  const handle = await originalOpen(...args);
  if (args[1] !== "wx" || !path.basename(file).startsWith("owner-")) return handle;
  let owner;
  return new Proxy(handle, {
    get(value, key) {
      if (key === "writeFile") return async (data, ...rest) => {
        owner = JSON.parse(String(data));
        if (mode === "before-write") await checkpoint({ file, owner, info: await handle.stat() });
        return handle.writeFile(data, ...rest);
      };
      if (key === "sync") return async (...rest) => {
        const result = await handle.sync(...rest);
        if (mode === "after-sync") await checkpoint({ file, owner, info: await handle.stat() });
        return result;
      };
      if (key === "close") return async (...rest) => {
        const result = await handle.close(...rest);
        if (mode === "before-publish" && !publicationBarrierUsed) {
          publicationBarrierUsed = true;
          await checkpoint({ from: path.dirname(file), to: canonical }, true);
        }
        return result;
      };
      const member = Reflect.get(value, key, value);
      return typeof member === "function" ? member.bind(value) : member;
    },
  });
};

childProcess.execFile = (executable, args, options, callback) => {
  if (!args?.includes("--publish-lock-directory")) return originalExecFile(executable, args, options, callback);
  nativeInvocations += 1;
  return originalExecFile(executable, args, options, (error, stdout, stderr) => {
    // Drop only a real successful reply AFTER the actual execFile child closes.
    // Neither the native mutation nor its exit/error/close events are replaced.
    if (mode === "lose-reply" && !error && stdout) {
        process.send({ kind: "checkpoint", pid: process.pid, lostReply: true });
        stdout = "";
    }
    callback(error, stdout, stderr);
  });
};
syncBuiltinESMExports();

try {
  const { withInterprocessLocks } = await import(moduleUrl);
  await withInterprocessLocks([target], async () => process.send({ kind: "entered", nativeInvocations }), {
    timeoutMs: 80, retryDelayMs: 2,
  });
} catch (error) {
  process.send({ kind: "refused", code: error.code, message: error.message, nativeInvocations });
} finally {
  process.disconnect();
}
