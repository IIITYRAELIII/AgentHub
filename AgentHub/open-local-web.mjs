import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { defaultRuntimeRoot } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { localWebAccessUrl } from "./src/interfaces/web/local-web-auth.mjs";

const runtimeRoot = path.resolve(process.env.AGENT_HUB_RUNTIME_ROOT ?? defaultRuntimeRoot());
const secret = String(await readFile(path.join(runtimeRoot, "local-web.secret"), "utf8")).trim();
const baseUrl = process.argv[2] ?? "http://127.0.0.1:8787/";
const url = localWebAccessUrl(baseUrl, secret);

const child = process.platform === "win32"
  ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
  : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
child.unref();
