import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { RecordingContourProvider } from "./recording-contour-provider.mjs";
import { buildClaudePrompt } from "./claude/claude.mjs";

async function ownedDirectory(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Recording directory escaped its root");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Recording directories cannot use links");
  }
}

export async function prepareClaudeRecordingLaunch({ root, run, input, temporaryFiles }) {
  // Opening validates the persistent root marker, symlinks and seeded identity.
  const provider = new RecordingContourProvider({ root, provider: "claude" });
  try {
    if (!run.clientUserMessageId || !run.turnId) throw new Error("Recording launch requires exact command and turn IDs");
    const thread = provider.thread(run.threadId);
    const execution = provider.paths.executionView({ projectRoot: run.projectRoot, input, temporaryFiles });
    if (thread.cwd !== execution.projectRoot) throw new Error("Recording launch target differs from its seeded Thread");
    const request = { threadId: run.threadId, clientUserMessageId: run.clientUserMessageId, turnId: run.turnId, input,
      expectedStdin: buildClaudePrompt(execution.input) };
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const directory = path.join(root, "requests");
    await ownedDirectory(root, directory);
    const requestFile = path.join(directory, `${hash}.json`);
    try { await writeFile(requestFile, JSON.stringify(request), { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await lstat(requestFile)).isSymbolicLink() || await readFile(requestFile, "utf8") !== JSON.stringify(request)) throw new Error("Recording request identity conflict");
    }
    await ownedDirectory(root, execution.projectRoot);
    // No production credentials or account homes are inherited by this process.
    return { command: process.execPath,
      args: [path.join(import.meta.dirname, "recording-contour-claude-cli.mjs"), "--recording-root", root, "--request-file", requestFile],
      cwd: execution.projectRoot,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
        AGENT_HUB_TEST_CONTOUR: "1", AGENT_HUB_RECORDING_PROVIDER_ROOT: root },
      input: request.expectedStdin,
      temporaryFiles: execution.temporaryFiles,
    };
  } finally { provider.close(); }
}
