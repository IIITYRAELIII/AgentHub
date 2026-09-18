import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

/*
 * Test Contour stand-in for `claude auth login` and `claude auth status`. It
 * follows only the stdin contract Agent Hub relies on: the manual sign-in link
 * line, then one `code#state` line. It never opens a browser, never reaches the
 * network and accepts only synthetic `test-contour-*` codes, so the Server page
 * sign-in can be exercised without a real account.
 */
const INVALID_CODE = "Invalid code. Please make sure the full code was copied.";
const argv = process.argv.slice(2);
const stateFlag = argv.indexOf("--state");
const stateFile = stateFlag >= 0 ? path.resolve(String(argv[stateFlag + 1] ?? "")) : "";
const command = argv.filter((_value, index) => stateFlag < 0 || (index !== stateFlag && index !== stateFlag + 1));
const runtimeRoot = String(process.env.AGENT_HUB_RUNTIME_ROOT ?? "").trim();

function insideRuntime(candidate) {
  const relative = path.relative(path.resolve(runtimeRoot), candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

if (process.env.AGENT_HUB_TEST_CONTOUR !== "1" || !runtimeRoot || !stateFile || !insideRuntime(stateFile)) {
  process.stderr.write("Test Contour Claude CLI is restricted to its owned Test Contour runtime\n");
  process.exit(2);
}

function readState() {
  if (!existsSync(stateFile)) return { loggedIn: false };
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function writeState(value) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, stateFile);
}

const [group, action] = command;
if (group === "auth" && action === "status") {
  const state = readState();
  process.stdout.write(`${JSON.stringify({
    loggedIn: state.loggedIn === true,
    authMethod: "test-contour",
    apiProvider: "test-contour",
  })}\n`);
  process.exit(0);
}

if (group === "auth" && action === "login") {
  const attempt = `${process.pid}-${Date.now()}`;
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write(`If the browser didn't open, visit: https://127.0.0.1:9/agent-hub-test-contour/claude-login?attempt=${attempt}\n`);
  process.stdout.write("Paste code here if prompted > ");
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const [code, state] = line.trim().split("#");
    if (!code || !state) {
      process.stderr.write(`${INVALID_CODE}\n`);
      return;
    }
    lines.close();
    if (!/^test-contour-[A-Za-z0-9_-]+$/u.test(code)) {
      process.stderr.write("Login failed: Test Contour accepts only synthetic test-contour-* codes\n");
      process.exit(1);
    }
    writeState({ loggedIn: true, attempt, loggedInAt: new Date().toISOString() });
    process.stdout.write("Login successful.\n");
    process.exit(0);
  });
} else {
  process.stderr.write("Test Contour Claude CLI supports only `auth login` and `auth status`\n");
  process.exit(2);
}
