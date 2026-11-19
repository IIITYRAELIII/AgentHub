import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { protectRuntimeDirectory } from "./runtime-security.mjs";

// Current-user DPAPI. Plaintext crosses private redirected stdin/stdout only;
// never a command argument, environment variable, diagnostic or shell source.
export function windowsAccountCrypt(value, decrypt = false) {
  if (process.platform !== "win32") throw new Error("GitHub secure storage requires Windows DPAPI");
  const script = "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; "
    + "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); "
    + "$r=[Security.Cryptography.ProtectedData]::" + (decrypt ? "Unprotect" : "Protect")
    + "($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
    + "[Console]::Write([Convert]::ToBase64String($r)) } catch { exit 1 }";
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("GitHub secure storage is unavailable")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(output.trim())) reject(new Error("GitHub secure storage is unavailable"));
      else resolve(Buffer.from(output.trim(), "base64"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(value).toString("base64"));
  });
}

export async function atomicAccountFile(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export class GitHubAccountVault {
  constructor({ directory, crypt = windowsAccountCrypt, protect = protectRuntimeDirectory }) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "account.json");
    this.profileFile = path.join(this.directory, "gitconfig");
    this.crypt = crypt;
    this.protect = protect;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.protect(this.directory);
  }
  async read() {
    try {
      const body = await readFile(this.file, "utf8");
      if (Buffer.byteLength(body) > 32_768) throw new Error();
      const row = JSON.parse(body);
      if (row.version !== 1 || !/^[0-9a-f-]{36}$/u.test(row.id) || !row.account?.login
        || !row.account.name || !row.account.email || typeof row.secret !== "string"
        || !/^[A-Za-z0-9+/]+={0,2}$/u.test(row.secret)) throw new Error();
      return row;
    }
    catch (error) { if (error.code === "ENOENT") return null; throw new Error("GitHub account storage cannot be read"); }
  }
  #rejectionFile(id) {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("Invalid GitHub connection identity");
    return path.join(this.directory, `rejected-${id}.json`);
  }
  async rejected(id) {
    try { return JSON.parse(await readFile(this.#rejectionFile(id), "utf8")).id === id; }
    catch (error) { if (error.code === "ENOENT") return false; throw new Error("GitHub authorization state cannot be read"); }
  }
  // Per-connection rejection cannot be overwritten by a late older Git helper.
  async reject(id) { await atomicAccountFile(this.#rejectionFile(id), JSON.stringify({ id })); }
  async token(row) {
    if (!row?.id || !row.secret || await this.rejected(row.id)) throw new Error("Переподключите GitHub-аккаунт");
    return (await this.crypt(Buffer.from(row.secret, "base64"), true)).toString("utf8");
  }
  async save({ id, account, token }) {
    const secret = (await this.crypt(Buffer.from(token))).toString("base64");
    await atomicAccountFile(this.file, JSON.stringify({ version: 1, id, account, secret }));
  }
  async remove() { await unlink(this.file).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
