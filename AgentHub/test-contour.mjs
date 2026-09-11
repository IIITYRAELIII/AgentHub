import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./src/infrastructure/process/main-module.mjs";
import { acceptReleaseArtifact } from "./src/runtime/test-contour-release-acceptance.mjs";
import {
  defaultTestContourRoot,
  adoptRecordingTestContour,
  cloneProductionDataToTestContour,
  installTestContour,
  openTestContour,
  readTestContourStatus,
  serveTestContour,
  startTestContour,
  stopTestContour,
  testContourComponentEnabled,
  TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE,
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
    releaseCandidate: false,
    withAgent: true,
    json: false,
    model: undefined,
    releaseId: undefined,
    operationId: undefined,
    sourceBranch: undefined,
    sourceHeadCommit: undefined,
    expectedOperationId: undefined,
    expectedHeadCommit: undefined,
  };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root" && args[index + 1]) options.root = path.resolve(args[++index]);
    else if (argument === "--prepared-root" && args[index + 1]) options.preparedRoot = path.resolve(args[++index]);
    else if (argument === "--port" && args[index + 1]) options.port = Number(args[++index]);
    else if (argument === "--allow-uninstalled" || argument === "--component-approved") options.allowUninstalled = true;
    else if (argument === "--require-installed") options.requireInstalled = true;
    else if (argument === "--release-candidate") options.releaseCandidate = true;
    else if (argument === "--no-agent") options.withAgent = false;
    else if (argument === "--model" && args[index + 1]) options.model = args[++index];
    else if (argument === "--release-id" && args[index + 1]) options.releaseId = args[++index];
    else if (argument === "--operation-id" && args[index + 1]) options.operationId = args[++index];
    else if (argument === "--source-branch" && args[index + 1]) options.sourceBranch = args[++index];
    else if (argument === "--source-head" && args[index + 1]) options.sourceHeadCommit = args[++index];
    else if (argument === "--protected-runtime-root" && args[index + 1]) options.protectedRuntimeRoot = args[++index];
    else if (argument === "--expected-operation" && args[index + 1]) options.expectedOperationId = args[++index];
    else if (argument === "--expected-head" && args[index + 1]) options.expectedHeadCommit = args[++index];
    else if (argument === "--json") options.json = true;
    else if (argument === "--artifact" && args[index + 1]) options.artifactRoot = path.resolve(args[++index]);
    else if (argument === "--previous-artifact" && args[index + 1]) options.previousArtifactRoot = path.resolve(args[++index]);
    else if (argument === "--output-root" && args[index + 1]) options.outputRoot = path.resolve(args[++index]);
    else throw new Error(`Unknown Test Contour argument: ${argument}`);
  }
  if (options.releaseCandidate && command !== "verify") {
    throw new Error("--release-candidate is supported only by Test Contour verify");
  }
  if (options.preparedRoot && command !== "adopt-recording") throw new Error("--prepared-root requires adopt-recording");
  if (options.protectedRuntimeRoot && command !== "serve") throw new Error("Protected runtime identity is only accepted by serve");
  if (command !== "accept-release" && (options.artifactRoot || options.previousArtifactRoot || options.outputRoot)) {
    throw new Error("Artifact arguments are supported only by accept-release");
  }
  if (command === "accept-release" && args.includes("--root")) {
    throw new Error("accept-release always creates a fresh run root; use --output-root for its parent directory");
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
  if (options.command === "accept-release") {
    const result = await acceptReleaseArtifact({
      artifactRoot: options.artifactRoot,
      previousArtifactRoot: options.previousArtifactRoot,
      ...(options.outputRoot ? { outputRoot: options.outputRoot } : {}),
    });
    print({ status: result.status, scope: result.scope, productionParity: result.productionParity,
      artifacts: result.artifacts, manifestFile: result.manifestFile,
      excluded: result.scenarios.filter((scenario) => scenario.status === "excluded") }, options.json);
    return result;
  }
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
    return serveTestContour({
      ...common,
      releaseId: options.releaseId,
      operationId: options.operationId,
      sourceBranch: options.sourceBranch,
      sourceHeadCommit: options.sourceHeadCommit,
      protectedRuntimeRoot: options.protectedRuntimeRoot,
      ...(options.model ? { model: options.model } : {}),
      ...(options.port ? { port: options.port } : {}),
    });
  }
  if (options.command === "status") {
    const result = await readTestContourStatus({
      ...common,
      expectedOperationId: options.expectedOperationId,
      expectedHeadCommit: options.expectedHeadCommit,
    });
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
  if (options.command === "clone-data") {
    await requireComponent(options);
    const launch = {
      ...common,
      entryFile,
      ...(options.model ? { model: options.model } : {}),
      ...(options.port ? { port: options.port } : {}),
    };
    const clone = await cloneProductionDataToTestContour(launch);
    const state = await startTestContour(launch);
    const result = { ...clone, running: true, url: state.url, releaseId: state.releaseId };
    print(result, options.json);
    return result;
  }
  if (["start", "refresh"].includes(options.command)) {
    await requireComponent(options);
    const state = await startTestContour({
      ...common,
      entryFile,
      refresh: options.command === "refresh",
      ...(options.model ? { model: options.model } : {}),
      ...(options.port ? { port: options.port } : {}),
    });
    if (options.json) print(state, true);
    else print(`Test Contour готов: ${state.url} (${state.refreshOutcome ?? "started"})`);
    return state;
  }
  if (options.command === "adopt-recording") {
    await requireComponent(options);
    const result = await adoptRecordingTestContour({ ...common, entryFile, preparedRoot: options.preparedRoot,
      ...(options.model ? { model: options.model } : {}), ...(options.port ? { port: options.port } : {}) });
    print(result, options.json);
    return result;
  }
  if (options.command === "verify") {
    if (options.requireInstalled || !options.allowUninstalled) await requireComponent(options);
    const result = await verifyTestContour({
      ...common,
      entryFile,
      withAgent: options.withAgent,
      ...(options.releaseCandidate ? { sourceKind: TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.port ? { port: options.port } : {}),
    });
    print({
      ok: true,
      url: result.state.url,
      releaseId: result.state.releaseId,
      model: result.state.model,
      screenshot: result.smoke.screenshot,
      withAgent: result.smoke.withAgent,
      sameTabAuth: result.smoke.sameTabAuth,
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
