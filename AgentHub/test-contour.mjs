import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./src/infrastructure/process/main-module.mjs";
import {
  defaultTestContourRoot,
  installTestContour,
  openTestContour,
  readTestContourStatus,
  serveTestContour,
  startTestContour,
  stopTestContour,
  testContourComponentEnabled,
  uninstallTestContour,
  verifyTestContour,
} from "./src/runtime/test-contour-manager.mjs";

function parseArguments(args) {
  const command = String(args[0] ?? "status").trim().toLowerCase();
  const options = {
    command,
    root: defaultTestContourRoot(),
    port: undefined,
    allowUninstalled: false,
    requireInstalled: false,
    withAgent: true,
    json: false,
  };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root" && args[index + 1]) options.root = path.resolve(args[++index]);
    else if (argument === "--port" && args[index + 1]) options.port = Number(args[++index]);
    else if (argument === "--allow-uninstalled" || argument === "--component-approved") options.allowUninstalled = true;
    else if (argument === "--require-installed") options.requireInstalled = true;
    else if (argument === "--no-agent") options.withAgent = false;
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown Test Contour argument: ${argument}`);
  }
  return options;
}

async function requireComponent(options) {
  if (options.allowUninstalled) return;
  const enabled = await testContourComponentEnabled();
  if (!enabled) {
    throw new Error(
      "Компонент test-contour не установлен. Запустите python install.py --enable-component test-contour.",
    );
  }
}

function print(value, json = false) {
  if (json) console.log(JSON.stringify(value));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const entryFile = fileURLToPath(import.meta.url);
  const common = { root: options.root };
  if (options.command === "install") {
    if (!options.allowUninstalled) await requireComponent(options);
    const result = await installTestContour(common);
    print({ installed: true, root: result.root, playwrightCore: "1.62.1" }, options.json);
    return result;
  }
  if (options.command === "uninstall") {
    const result = await uninstallTestContour(common);
    print(result, options.json);
    return result;
  }
  if (options.command === "serve") {
    return serveTestContour({ ...common, ...(options.port ? { port: options.port } : {}) });
  }
  if (options.command === "status") {
    const result = await readTestContourStatus(common);
    print(result, options.json);
    return result;
  }
  if (options.command === "stop") {
    const result = await stopTestContour(common);
    print(result, options.json);
    return result;
  }
  if (options.command === "open") {
    await requireComponent(options);
    const result = await openTestContour(common);
    print(`Test Contour открыт: ${result.url}`, options.json);
    return result;
  }
  if (["start", "refresh"].includes(options.command)) {
    await requireComponent(options);
    const state = await startTestContour({
      ...common,
      entryFile,
      refresh: options.command === "refresh",
      ...(options.port ? { port: options.port } : {}),
    });
    print(`Test Contour готов: ${state.url}`, options.json);
    return state;
  }
  if (options.command === "verify") {
    if (options.requireInstalled || !options.allowUninstalled) await requireComponent(options);
    const result = await verifyTestContour({
      ...common,
      entryFile,
      withAgent: options.withAgent,
    });
    print({
      ok: true,
      url: result.state.url,
      releaseId: result.state.releaseId,
      model: result.state.model,
      screenshot: result.smoke.screenshot,
      withAgent: result.smoke.withAgent,
      journal: result.journal,
    }, options.json);
    return result;
  }
  throw new Error(`Unknown Test Contour command: ${options.command}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Test Contour failed: ${error.message}`);
    process.exitCode = 1;
  });
}
