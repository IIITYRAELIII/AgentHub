import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  realpath,
  rename as fsRename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { prepareTaskWorktreeDependencies } from "../../../src/infrastructure/filesystem/task-worktree-dependencies.mjs";

const NPM_CI_ARGS = ["ci", "--include=dev", "--include=optional", "--no-audit", "--no-fund"];

function rmTree(target) {
  return rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

async function writeNpmProject(root, {
  name = "task-fixture",
  dependencies = {},
  devDependencies = {},
  optionalDependencies = {},
  packageEntries = {},
} = {}) {
  await mkdir(root, { recursive: true });
  const packageJson = { name, private: true, dependencies, devDependencies, optionalDependencies };
  const lock = { name, lockfileVersion: 3, packages: { "": packageJson, ...packageEntries } };
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function npmProject(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-dependencies-"));
  context.after(() => rmTree(root));
  await writeNpmProject(root, {
    devDependencies: { playwright: "1.62.1" },
    packageEntries: {
      "node_modules/playwright": {
        version: "1.62.1",
        resolved: "https://registry.example.invalid/playwright-1.62.1.tgz",
        integrity: "sha512-fixture",
        dev: true,
      },
    },
  });
  return root;
}

async function prismaProject(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-prisma-"));
  context.after(() => rmTree(root));
  await writeNpmProject(root, {
    dependencies: { "@prisma/client": "6.19.3" },
    packageEntries: {
      "node_modules/@prisma/client": {
        version: "6.19.3",
        resolved: "https://registry.example.invalid/prisma-client-6.19.3.tgz",
        integrity: "sha512-prisma-client-fixture",
        hasInstallScript: true,
      },
    },
  });
  return root;
}

function packageName(packagePath) {
  const segments = packagePath.split("/");
  return segments.at(-2)?.startsWith("@")
    ? `${segments.at(-2)}/${segments.at(-1)}`
    : segments.at(-1);
}

async function materializeLockedState(packageRoot, { omit = [] } = {}) {
  const lock = JSON.parse(await readFile(path.join(packageRoot, "package-lock.json"), "utf8"));
  const omitted = new Set(omit);
  const installedPackages = {};
  await rmTree(path.join(packageRoot, "node_modules"));
  await mkdir(path.join(packageRoot, "node_modules"), { recursive: true });
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (!packagePath.startsWith("node_modules/") || omitted.has(packagePath)) continue;
    const packageDirectory = path.resolve(packageRoot, ...packagePath.split("/"));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify({
      name: packageName(packagePath),
      version: entry.version,
    })}\n`, "utf8");
    installedPackages[packagePath] = entry;
  }
  await writeFile(path.join(packageRoot, "node_modules", ".package-lock.json"), `${JSON.stringify({
    lockfileVersion: 3,
    packages: installedPackages,
  }, null, 2)}\n`, "utf8");
}

async function materializePrismaGeneratedState(packageRoot, { hiddenEntry = false } = {}) {
  await materializeLockedState(packageRoot);
  const clientRoot = path.join(packageRoot, "node_modules", ".prisma", "client");
  await mkdir(path.join(clientRoot, "runtime"), { recursive: true });
  await writeFile(path.join(clientRoot, "index.js"), "export const generated = true;\n", "utf8");
  await writeFile(path.join(clientRoot, "runtime", "library.js"), "export const runtime = true;\n", "utf8");
  if (hiddenEntry) await writeFile(path.join(clientRoot, ".foreign"), "unexpected\n", "utf8");
}

test("ensure reuses unchanged inputs without scanning packages; verify repairs reported damage", async (context) => {
  const projectRoot = await npmProject(context);
  let installs = 0;
  let packageReads = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    verify: false,
    runNpm: async (_args, { cwd }) => { installs += 1; await materializeLockedState(cwd); },
    fileSystem: {
      open: async (file, ...args) => {
        if (String(file).replaceAll("\\", "/").endsWith("node_modules/playwright/package.json")) packageReads += 1;
        return fsOpen(file, ...args);
      },
    },
  };
  await prepareTaskWorktreeDependencies(input);
  assert.equal(installs, 1);
  packageReads = 0;
  await prepareTaskWorktreeDependencies(input);
  assert.equal(installs, 1);
  assert.equal(packageReads, 0);
  await writeFile(path.join(projectRoot, "node_modules", "playwright", "package.json"), "{broken", "utf8");
  await prepareTaskWorktreeDependencies({ ...input, verify: true });
  assert.equal(installs, 2);
  assert.ok(packageReads > 0);
  const manifest = path.join(projectRoot, "package.json");
  await writeFile(manifest, (await readFile(manifest, "utf8")) + "\n", "utf8");
  await prepareTaskWorktreeDependencies(input);
  assert.equal(installs, 3);
  await writeFile(path.join(projectRoot, "node_modules", ".package-lock.json"), "{broken", "utf8");
  await prepareTaskWorktreeDependencies(input);
  assert.equal(installs, 4);
});

test("lock and installed metadata jointly gate dependency reuse", async (context) => {
  const projectRoot = await npmProject(context);
  const calls = [];
  const runNpm = async (args, { cwd }) => {
    calls.push({ args, cwd });
    await materializeLockedState(cwd);
  };
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm,
  };

  const first = await prepareTaskWorktreeDependencies(input);
  const repeated = await prepareTaskWorktreeDependencies(input);
  assert.deepEqual(calls, [{ args: NPM_CI_ARGS, cwd: projectRoot }]);
  assert.equal(first[0].prepared, true);
  assert.equal(repeated[0].prepared, false);
  const markerPath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(Object.hasOwn(marker, "installedStateSha256"), true);
  assert.equal(JSON.stringify(marker).includes(projectRoot), false);

  await writeFile(path.join(projectRoot, "node_modules", "playwright", "package.json"), `${JSON.stringify({
    name: "playwright",
    version: "0.0.0-stale",
  })}\n`, "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls.length, 2);

  await writeFile(path.join(projectRoot, "node_modules", "playwright", "package.json"), `${JSON.stringify({
    name: "impostor",
    version: "1.62.1",
  })}\n`, "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls.length, 3);

  await writeFile(path.join(projectRoot, "node_modules", "playwright", "package.json"), "{malformed\n", "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls.length, 4);

  const installedLockPath = path.join(projectRoot, "node_modules", ".package-lock.json");
  const staleInstalledLock = JSON.parse(await readFile(installedLockPath, "utf8"));
  staleInstalledLock.packages["node_modules/playwright"].integrity = "sha512-stale";
  await writeFile(installedLockPath, `${JSON.stringify(staleInstalledLock, null, 2)}\n`, "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls.length, 5);

  const changedLock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  changedLock.packages["node_modules/playwright"].resolved = "https://registry.example.invalid/repacked.tgz";
  await writeFile(path.join(projectRoot, "package-lock.json"), `${JSON.stringify(changedLock, null, 2)}\n`, "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls.length, 6);
});

test("a Windows 8.3 project-root alias does not create a false containment escape", {
  skip: process.platform !== "win32" ? "Windows-specific 8.3 path behavior" : false,
}, async (context) => {
  const projectRoot = await npmProject(context);
  const resolvedRoot = await realpath(projectRoot);
  if (projectRoot.toLowerCase() === resolvedRoot.toLowerCase()) {
    context.skip("temporary directory has no distinct Windows 8.3 alias");
    return;
  }
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await materializeLockedState(cwd);
    },
  };

  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
  assert.equal(calls, 1);
});

test("a project-root link is rejected before invoking npm", async (context) => {
  const physicalRoot = await npmProject(context);
  const linkedRoot = `${physicalRoot}-linked`;
  context.after(() => rmTree(linkedRoot));
  await symlink(physicalRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  let invoked = false;

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot: linkedRoot,
    lockfiles: [path.join(linkedRoot, "package-lock.json")],
    runNpm: async () => {
      invoked = true;
    },
  }), /project root must use a local directory/u);
  assert.equal(invoked, false);
});

test("lock-backed local Prisma generated artifacts participate in dependency reuse", async (context) => {
  const projectRoot = await prismaProject(context);
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await materializePrismaGeneratedState(cwd);
    },
  };

  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
  assert.equal(calls, 1);

  const installedLockPath = path.join(projectRoot, "node_modules", ".package-lock.json");
  const installedLock = JSON.parse(await readFile(installedLockPath, "utf8"));
  installedLock.packages["node_modules/@prisma/client"].integrity = "sha512-stale";
  await writeFile(installedLockPath, `${JSON.stringify(installedLock, null, 2)}\n`, "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls, 2);
});

test("Prisma generated artifacts require the genuine client identity, not an npm alias pathname", async (context) => {
  const aliasRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-prisma-alias-"));
  context.after(() => rmTree(aliasRoot));
  await writeNpmProject(aliasRoot, {
    dependencies: { "@prisma/client": "npm:not-prisma@1.0.0" },
    packageEntries: {
      "node_modules/@prisma/client": {
        name: "not-prisma",
        version: "1.0.0",
        resolved: "https://registry.example.invalid/not-prisma.tgz",
        integrity: "sha512-fixture",
      },
    },
  });
  let aliasCalls = 0;
  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot: aliasRoot,
    lockfiles: [path.join(aliasRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      aliasCalls += 1;
      await materializeLockedState(cwd);
      await writeFile(path.join(cwd, "node_modules", "@prisma", "client", "package.json"),
        "{\"name\":\"not-prisma\",\"version\":\"1.0.0\"}\n", "utf8");
      const generatedRoot = path.join(cwd, "node_modules", ".prisma", "client");
      await mkdir(generatedRoot, { recursive: true });
      await writeFile(path.join(generatedRoot, "unrelated.js"), "export const unrelated = true;\n", "utf8");
    },
  }), /does not match its lockfile/u);
  assert.equal(aliasCalls, 1);

  const genuineRoot = await prismaProject(context);
  let genuineCalls = 0;
  const genuineInput = {
    projectRoot: genuineRoot,
    lockfiles: [path.join(genuineRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      genuineCalls += 1;
      await materializePrismaGeneratedState(cwd);
    },
  };
  assert.equal((await prepareTaskWorktreeDependencies(genuineInput))[0].prepared, true);
  assert.equal((await prepareTaskWorktreeDependencies(genuineInput))[0].prepared, false);
  assert.equal(genuineCalls, 1);
});

test("Prisma service state rejects missing lock identity and hidden generated entries", async (context) => {
  const unbackedRoot = await npmProject(context);
  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot: unbackedRoot,
    lockfiles: [path.join(unbackedRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      await materializeLockedState(cwd);
      const clientRoot = path.join(cwd, "node_modules", ".prisma", "client");
      await mkdir(clientRoot, { recursive: true });
      await writeFile(path.join(clientRoot, "index.js"), "unexpected\n", "utf8");
    },
  }), /does not match its lockfile/u);

  const hiddenRoot = await prismaProject(context);
  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot: hiddenRoot,
    lockfiles: [path.join(hiddenRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => materializePrismaGeneratedState(cwd, { hiddenEntry: true }),
  }), /does not match its lockfile/u);

  const unknownRoot = await npmProject(context);
  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot: unknownRoot,
    lockfiles: [path.join(unknownRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      await materializeLockedState(cwd);
      await mkdir(path.join(cwd, "node_modules", ".foreign"));
    },
  }), /does not match its lockfile/u);
});

test("Prisma generated artifacts reject links that escape the managed project", async (context) => {
  const projectRoot = await prismaProject(context);
  const externalRoot = `${projectRoot}-external`;
  context.after(() => rmTree(externalRoot));
  await mkdir(externalRoot);

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      await materializeLockedState(cwd);
      await symlink(
        externalRoot,
        path.join(cwd, "node_modules", ".prisma"),
        process.platform === "win32" ? "junction" : "dir",
      );
    },
  }), /must use a local directory/u);
});

test("a valid Prisma tree recovers from a matching cached pre-fix failure", async (context) => {
  const projectRoot = await prismaProject(context);
  const markerPath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies.json");
  const failurePath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies-failure.json");
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await materializePrismaGeneratedState(cwd);
    },
  };
  await prepareTaskWorktreeDependencies(input);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await rm(markerPath);
  await writeFile(failurePath, `${JSON.stringify({
    policy: marker.policy,
    lockfileSha256: marker.lockfileSha256,
    code: "TASK_DEPENDENCY_POST_INSTALL_INVALID",
    state: "lock-state-mismatch",
  })}\n`, "utf8");

  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls, 2);
  await assert.rejects(() => readFile(failurePath, "utf8"), /ENOENT/u);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
});

test("unexpected unscoped and scoped physical package roots invalidate reuse", async (context) => {
  const projectRoot = await npmProject(context);
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await materializeLockedState(cwd);
    },
  };
  await prepareTaskWorktreeDependencies(input);

  await mkdir(path.join(projectRoot, "node_modules", "attacker"));
  await writeFile(path.join(projectRoot, "node_modules", "attacker", "package.json"), "{\"name\":\"attacker\",\"version\":\"1.0.0\"}\n", "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls, 2);

  await mkdir(path.join(projectRoot, "node_modules", "@extra", "attacker"), { recursive: true });
  await writeFile(path.join(projectRoot, "node_modules", "@extra", "attacker", "package.json"), "{\"name\":\"@extra/attacker\",\"version\":\"1.0.0\"}\n", "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls, 3);
});

test("optional packages may be omitted but stale optional state is never reused", async (context) => {
  const projectRoot = await npmProject(context);
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  packageJson.optionalDependencies = { "platform-helper": "2.0.0" };
  const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  lock.packages[""] = packageJson;
  lock.packages["node_modules/platform-helper"] = {
    version: "2.0.0",
    resolved: "https://registry.example.invalid/platform-helper-2.0.0.tgz",
    integrity: "sha512-optional-fixture",
    os: ["darwin"],
  };
  await writeFile(path.join(projectRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(projectRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (args, { cwd }) => {
      calls += 1;
      assert.deepEqual(args, NPM_CI_ARGS);
      await materializeLockedState(cwd, { omit: ["node_modules/platform-helper"] });
    },
  };

  await prepareTaskWorktreeDependencies(input);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
  await mkdir(path.join(projectRoot, "node_modules", "platform-helper"));
  await writeFile(path.join(projectRoot, "node_modules", "platform-helper", "package.json"), `${JSON.stringify({
    name: "platform-helper",
    version: "1.0.0-stale",
  })}\n`, "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls, 2);
});

test("multiple nested lockfiles are prepared in their own package roots", async (context) => {
  const projectRoot = await npmProject(context);
  const nestedRoot = path.join(projectRoot, "plugins", "nested");
  await writeNpmProject(nestedRoot, {
    name: "nested-fixture",
    dependencies: { "nested-tool": "2.0.0" },
    packageEntries: { "node_modules/nested-tool": { version: "2.0.0", integrity: "sha512-nested" } },
  });
  const calls = [];
  const results = await prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(nestedRoot, "package-lock.json"), path.join(projectRoot, "package-lock.json")],
    runNpm: async (args, { cwd }) => {
      calls.push({ args, cwd });
      await materializeLockedState(cwd);
    },
  });

  assert.deepEqual(calls.map((call) => call.cwd), [projectRoot, nestedRoot]);
  for (const call of calls) assert.deepEqual(call.args, NPM_CI_ARGS);
  assert.deepEqual(results.map((result) => result.project), [".", "plugins/nested"]);
});

test("one interprocess lock coalesces concurrent preparation", async (context) => {
  const projectRoot = await npmProject(context);
  let installCalls = 0;
  let signalStarted;
  let releaseInstall;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const installGate = new Promise((resolve) => { releaseInstall = resolve; });
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    lockPath: path.join(projectRoot, ".locks", "dependencies"),
    runNpm: async (_args, { cwd, lease, signal }) => {
      installCalls += 1;
      assert.equal(typeof lease?.assertOwned, "function");
      assert.equal(signal, lease.signal);
      await lease.assertOwned();
      signalStarted();
      await installGate;
      await lease.assertOwned();
      await materializeLockedState(cwd);
    },
  };

  const first = prepareTaskWorktreeDependencies(input);
  await started;
  const concurrent = prepareTaskWorktreeDependencies(input);
  releaseInstall();
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
  assert.equal(installCalls, 1);
  assert.equal(firstResult[0].prepared, true);
  assert.equal(concurrentResult[0].prepared, false);
});

test("lease loss after npm prevents marker promotion", async (context) => {
  const projectRoot = await npmProject(context);
  const markerPath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies.json");
  const controller = new AbortController();
  let lost = false;
  const leaseError = new Error("fixture dependency lease was stolen");
  const lease = {
    signal: controller.signal,
    assertOwned: async () => {
      if (lost) throw leaseError;
    },
  };

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    lease,
    runNpm: async (_args, { cwd, lease: receivedLease, signal }) => {
      assert.equal(receivedLease, lease);
      assert.equal(signal, controller.signal);
      await materializeLockedState(cwd);
      lost = true;
      controller.abort(leaseError);
    },
  }), /lease was stolen/u);
  await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/u);
});

test("an aborted owned npm operation cannot promote a prepared marker", async (context) => {
  const projectRoot = await npmProject(context);
  const markerPath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies.json");
  const controller = new AbortController();
  const abortError = new Error("fixture npm was fenced");
  abortError.processTreeStopped = true;
  const lease = {
    signal: controller.signal,
    assertOwned: async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
  };

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    lease,
    runNpm: async (_args, { lease: receivedLease, signal }) => {
      assert.equal(receivedLease, lease);
      assert.equal(signal, controller.signal);
      controller.abort(abortError);
      throw abortError;
    },
  }), /npm was fenced/u);
  await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/u);
});

test("failed install leaves no marker and a later call retries", async (context) => {
  const projectRoot = await npmProject(context);
  const markerPath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies.json");
  let attempts = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      attempts += 1;
      if (attempts === 1) {
        await mkdir(path.join(cwd, "node_modules"), { recursive: true });
        throw new Error("fixture install failure");
      }
      await materializeLockedState(cwd);
    },
  };

  await assert.rejects(() => prepareTaskWorktreeDependencies(input), /fixture install failure/u);
  await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/u);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(attempts, 2);
});

test("source nesting overflow fails before npm can run", async (context) => {
  const projectRoot = await npmProject(context);
  const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  lock.packages["node_modules/first/node_modules/second/node_modules/third"] = { version: "1.0.0" };
  await writeFile(path.join(projectRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  let invoked = false;

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    limits: { maxNodeModulesNestingDepth: 2 },
    runNpm: async () => { invoked = true; },
  }), /maxNodeModulesNestingDepth=2/u);
  assert.equal(invoked, false);
});

test("source package and directory-entry bounds fail before npm can run", async (context) => {
  const projectRoot = await npmProject(context);
  const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  lock.packages["node_modules/second"] = { version: "1.0.0" };
  await writeFile(path.join(projectRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  let invoked = false;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async () => { invoked = true; },
  };

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    ...input,
    limits: { maxPackageRoots: 1 },
  }), /maxPackageRoots=1/u);
  await assert.rejects(() => prepareTaskWorktreeDependencies({
    ...input,
    limits: { maxEntriesPerDirectory: 1 },
  }), /maxEntriesPerDirectory=1/u);
  await assert.rejects(() => prepareTaskWorktreeDependencies({
    ...input,
    limits: { maxPackageLockBytes: 16 },
  }), /maxBytes=16/u);
  assert.equal(invoked, false);
});

test("source structural limits remain reachable without charging service entries", async (context) => {
  const projectRoot = await npmProject(context);
  const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  lock.packages["node_modules/second"] = { version: "1.0.0" };
  await writeFile(path.join(projectRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  let invoked = false;

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    limits: {
      maxPackageRoots: 2,
      maxEntriesPerDirectory: 2,
      maxTotalDirectoryEntries: 2,
    },
    runNpm: async () => {
      invoked = true;
      throw new Error("source-boundary-admitted");
    },
  }), /source-boundary-admitted/u);
  assert.equal(invoked, true);
});

test("post-install overflow is recorded and cannot loop npm ci", async (context) => {
  const projectRoot = await npmProject(context);
  const failurePath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies-failure.json");
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    limits: { maxEntriesPerDirectory: 1 },
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await materializeLockedState(cwd);
    },
  };

  await assert.rejects(() => prepareTaskWorktreeDependencies(input), /maxEntriesPerDirectory=1/u);
  const recorded = JSON.parse(await readFile(failurePath, "utf8"));
  assert.equal(recorded.code, "TASK_DEPENDENCY_TREE_LIMIT");
  await assert.rejects(() => prepareTaskWorktreeDependencies(input), /maxEntriesPerDirectory=1/u);
  assert.equal(calls, 1);

  const changedLock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  changedLock.revision = 2;
  await writeFile(path.join(projectRoot, "package-lock.json"), `${JSON.stringify(changedLock, null, 2)}\n`, "utf8");
  await assert.rejects(() => prepareTaskWorktreeDependencies(input), /maxEntriesPerDirectory=1/u);
  assert.equal(calls, 2);
  await rm(failurePath);
  await assert.rejects(() => prepareTaskWorktreeDependencies(input), /maxEntriesPerDirectory=1/u);
  assert.equal(calls, 2);
  await rmTree(path.join(projectRoot, "node_modules"));
  await assert.rejects(() => prepareTaskWorktreeDependencies(input), /maxEntriesPerDirectory=1/u);
  assert.equal(calls, 3);
});

test("post-install failure evidence is flushed and atomically renamed", async (context) => {
  const projectRoot = await npmProject(context);
  const failurePath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies-failure.json");
  const renames = [];
  const collisions = [];

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    limits: { maxEntriesPerDirectory: 1 },
    fileSystem: {
      open: async (target, flags, mode) => {
        if (flags === "wx" && target.includes("dependencies-failure") && collisions.length < 2) {
          await writeFile(target, "foreign collision\n", { flag: "wx" });
          collisions.push(target);
          const error = new Error("fixture temp collision");
          error.code = "EEXIST";
          throw error;
        }
        return fsOpen(target, flags, mode);
      },
      rename: async (source, destination) => {
        renames.push({ source, destination });
        await fsRename(source, destination);
      },
    },
    runNpm: async (_args, { cwd }) => materializeLockedState(cwd),
  }), /maxEntriesPerDirectory=1/u);

  assert.equal(renames.length, 1);
  assert.equal(collisions.length, 2);
  for (const collision of collisions) assert.equal(await readFile(collision, "utf8"), "foreign collision\n");
  assert.equal(renames[0].destination, failurePath);
  assert.equal(path.dirname(renames[0].source), path.dirname(failurePath));
  assert.match(path.basename(renames[0].source), /^\.\.agent-hub-task-dependencies-failure\.json\..+\.tmp$/u);
});

test("atomic evidence temp collision exhaustion preserves its destination", async (context) => {
  const projectRoot = await npmProject(context);
  const failurePath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies-failure.json");
  const collisions = [];

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    limits: { maxEntriesPerDirectory: 1 },
    fileSystem: {
      open: async (target, flags, mode) => {
        if (flags === "wx" && target.includes("dependencies-failure")) {
          await writeFile(target, "foreign collision\n", { flag: "wx" });
          collisions.push(target);
          const error = new Error("fixture exhausted temp collision");
          error.code = "EEXIST";
          throw error;
        }
        return fsOpen(target, flags, mode);
      },
    },
    runNpm: async (_args, { cwd }) => {
      await materializeLockedState(cwd);
      await writeFile(failurePath, "previous destination\n", "utf8");
    },
  }), (error) => error?.code === "EEXIST");

  assert.equal(collisions.length, 4);
  assert.equal(await readFile(failurePath, "utf8"), "previous destination\n");
  for (const collision of collisions) assert.equal(await readFile(collision, "utf8"), "foreign collision\n");
});

test("forged failure evidence cannot block a valid cached tree", async (context) => {
  const projectRoot = await npmProject(context);
  const markerPath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies.json");
  const failurePath = path.join(projectRoot, "node_modules", ".agent-hub-task-dependencies-failure.json");
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await materializeLockedState(cwd);
    },
  };
  await prepareTaskWorktreeDependencies(input);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(failurePath, `${JSON.stringify({
    policy: marker.policy,
    lockfileSha256: marker.lockfileSha256,
    code: "TASK_DEPENDENCY_TREE_LIMIT",
    state: "Task dependency tree exceeds maxEntriesPerDirectory=1",
  })}\n`, "utf8");

  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
  assert.equal(calls, 1);
  await assert.rejects(() => readFile(failurePath, "utf8"), /ENOENT/u);
});

test("opened-handle bounds stop an oversized lock swap before reading", async (context) => {
  const projectRoot = await npmProject(context);
  let readCalled = false;
  let closeCalled = false;
  const oversizedHandle = {
    stat: async () => ({
      isFile: () => true,
      size: 17,
      dev: 1,
      ino: 1,
      mtimeMs: 1,
    }),
    read: async () => {
      readCalled = true;
      return { bytesRead: 0 };
    },
    close: async () => { closeCalled = true; },
  };

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    limits: { maxPackageLockBytes: 16 },
    fileSystem: { open: async () => oversizedHandle },
    runNpm: async () => assert.fail("npm must not run for an oversized opened lock"),
  }), /maxBytes=16/u);
  assert.equal(readCalled, false);
  assert.equal(closeCalled, true);
});

test("a local file link uses its target package identity", async (context) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-link-"));
  context.after(() => rmTree(projectRoot));
  const packageRoot = path.join(projectRoot, "app");
  const targetRoot = path.join(projectRoot, "bar");
  await mkdir(targetRoot, { recursive: true });
  await writeFile(path.join(targetRoot, "package.json"), "{\"name\":\"bar\",\"version\":\"1.0.0\"}\n", "utf8");
  const linkEntry = { resolved: "../bar", link: true };
  await writeNpmProject(packageRoot, {
    dependencies: { foo: "file:../bar" },
    packageEntries: {
      "../bar": { name: "bar", version: "1.0.0" },
      "node_modules/foo": linkEntry,
    },
  });
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(packageRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await rmTree(path.join(cwd, "node_modules"));
      await mkdir(path.join(cwd, "node_modules"), { recursive: true });
      await symlink(targetRoot, path.join(cwd, "node_modules", "foo"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(path.join(cwd, "node_modules", ".package-lock.json"), `${JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/foo": linkEntry },
      }, null, 2)}\n`, "utf8");
    },
  };

  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
  assert.equal(calls, 1);
});

test("ensure invalidates reuse when a local linked package identity changes without a source lock change", async (context) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-link-reuse-"));
  context.after(() => rmTree(projectRoot));
  const packageRoot = path.join(projectRoot, "app");
  const targetRoot = path.join(projectRoot, "bar");
  const manifest = path.join(targetRoot, "package.json");
  await mkdir(targetRoot, { recursive: true });
  await writeFile(manifest, JSON.stringify({ name: "bar", version: "1.0.0" }), "utf8");
  const linkEntry = { resolved: "../bar", link: true };
  await writeNpmProject(packageRoot, {
    dependencies: { foo: "file:../bar" },
    packageEntries: { "node_modules/foo": linkEntry },
  });
  const lockfile = path.join(packageRoot, "package-lock.json");
  const sourceLock = await readFile(lockfile, "utf8");
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [lockfile],
    verify: false,
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await rmTree(path.join(cwd, "node_modules"));
      await mkdir(path.join(cwd, "node_modules"), { recursive: true });
      await symlink(targetRoot, path.join(cwd, "node_modules", "foo"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(path.join(cwd, "node_modules", ".package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/foo": linkEntry },
      }), "utf8");
    },
  };
  const first = (await prepareTaskWorktreeDependencies(input))[0];
  assert.equal(first.prepared, true);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
  assert.equal(calls, 1);
  await writeFile(manifest, JSON.stringify({ name: "bar", version: "2.0.0" }), "utf8");
  assert.equal(await readFile(lockfile, "utf8"), sourceLock);
  const changed = (await prepareTaskWorktreeDependencies(input))[0];
  assert.equal(changed.prepared, true);
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.equal(calls, 2);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
  assert.equal(calls, 2);
});

test("a local file link target cannot escape the managed project", async (context) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-task-link-root-"));
  const externalRoot = `${projectRoot}-external`;
  context.after(() => rmTree(projectRoot));
  context.after(() => rmTree(externalRoot));
  await mkdir(externalRoot, { recursive: true });
  await writeFile(path.join(externalRoot, "package.json"), "{\"name\":\"outside\",\"version\":\"1.0.0\"}\n", "utf8");
  const relativeTarget = `../${path.basename(externalRoot)}`;
  await writeNpmProject(projectRoot, {
    dependencies: { outside: `file:${relativeTarget}` },
    packageEntries: {
      [relativeTarget]: { name: "outside", version: "1.0.0" },
      "node_modules/outside": { resolved: relativeTarget, link: true },
    },
  });
  let invoked = false;

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async () => { invoked = true; },
  }), /link target escaped its managed project/u);
  assert.equal(invoked, false);
});

test("a non-link alias uses the package name recorded by the lock", async (context) => {
  const projectRoot = await npmProject(context);
  await writeNpmProject(projectRoot, {
    dependencies: { alias: "npm:real-package@1.0.0" },
    packageEntries: {
      "node_modules/alias": { name: "real-package", version: "1.0.0", integrity: "sha512-alias" },
    },
  });
  let calls = 0;
  const input = {
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async (_args, { cwd }) => {
      calls += 1;
      await materializeLockedState(cwd);
      await writeFile(path.join(cwd, "node_modules", "alias", "package.json"),
        "{\"name\":\"real-package\",\"version\":\"1.0.0\"}\n", "utf8");
    },
  };

  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, false);
  await writeFile(path.join(projectRoot, "node_modules", "alias", "package.json"),
    "{\"name\":\"alias\",\"version\":\"1.0.0\"}\n", "utf8");
  assert.equal((await prepareTaskWorktreeDependencies(input))[0].prepared, true);
  assert.equal(calls, 2);
});

test("dependency preparation rejects a node_modules link before invoking npm", async (context) => {
  const projectRoot = await npmProject(context);
  const external = path.join(projectRoot, "..", `${path.basename(projectRoot)}-external`);
  context.after(() => rmTree(external));
  await mkdir(external);
  await symlink(external, path.join(projectRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  let invoked = false;

  await assert.rejects(() => prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    runNpm: async () => { invoked = true; },
  }), /must use a local directory/u);
  assert.equal(invoked, false);
});
