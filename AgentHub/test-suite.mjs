import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const testScript = String(packageJson.scripts?.test ?? "").trim();
const prefix = "node --test ";
if (!testScript.startsWith(prefix)) throw new Error("Не удалось прочитать список unit-тестов из package.json.");

const testFiles = testScript.slice(prefix.length).trim().split(/\s+/);
const isolatedFile = "tts-worker-client.test.mjs";
const sharedFiles = testFiles.filter((file) => file !== isolatedFile);
if (sharedFiles.length === testFiles.length) throw new Error(`В общем наборе нет ${isolatedFile}.`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Тестовый этап завершён с ${signal ?? `кодом ${code}`}.`));
    });
  });
}

const npmCli = String(process.env.npm_execpath ?? "").trim();
const npmCommand = npmCli
  ? { command: process.execPath, args: [npmCli, "run", "pretest"] }
  : process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm", "run", "pretest"] }
    : { command: "npm", args: ["run", "pretest"] };

await run(npmCommand.command, npmCommand.args);
await run(process.execPath, ["--test", "--test-concurrency=4", ...sharedFiles]);
await run(process.execPath, ["--test", "--test-concurrency=1", isolatedFile]);
