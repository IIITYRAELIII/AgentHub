import { readReleaseToolPackage } from "../../src/infrastructure/process/release-tool-package.mjs";
const tool = await readReleaseToolPackage();
await tool.assertUnchanged();
export const { buildWindowsRuntimeHost, buildWindowsIcon, windowsIconEntries,
  runtimeHostCompilerCandidates, runtimeHostSourceHash, RUNTIME_HOST_SOURCE_INPUTS } =
  await tool.module("src/agent-hub/src/infrastructure/process/runtime-host-builder.mjs");
