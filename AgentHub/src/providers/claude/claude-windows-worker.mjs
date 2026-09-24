import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  writeSync(2, "Agent Hub Claude worker received no provider command\n");
  process.exit(127);
}

let provider;
try {
  provider = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
} catch (error) {
  writeSync(2, `Agent Hub could not start Claude: ${error.message}\n`);
  process.exit(127);
}

provider.once("error", (error) => {
  writeSync(2, `Agent Hub could not start Claude: ${error.message}\n`);
  process.exit(127);
});

provider.once("exit", (code) => {
  process.exit(Number.isInteger(code) ? code : 1);
});
