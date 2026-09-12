import { pathToFileURL } from "node:url";
import { loadConfig } from "../../infrastructure/filesystem/config.mjs";
import { TaskGitWorkspaceService } from "../../infrastructure/filesystem/task-git-workspace.mjs";
import { enableGithubReleaseBaseline, previewGithubReleaseBaseline } from "../../infrastructure/persistence/github-publication-baseline.mjs";
import { writePublicationState } from "../../infrastructure/persistence/publication-state.mjs";

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value == null || value.startsWith("--")) {
      throw new Error(`Invalid option: ${flag ?? ""}`);
    }
    options[flag.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

function githubBaselineInput(options) {
  return {
    projectRoot: options.project_root,
    owner: options.owner,
    repo: options.repo,
    releaseTag: options.tag,
    releaseId: options.release_id,
    expectedTargetCommit: options.target_commit,
  };
}

function taskUpstreamAdoptionInput(options) {
  return {
    projectRoot: options.project_root,
    taskId: options.task_id,
    taskNumber: options.task_number ?? null,
    branch: options.branch ?? null,
    taskBaseCommit: options.task_base,
    acceptedLocalMainCommit: options.accepted_local_main,
    adoptedCommit: options.adopted_commit,
    snapshotCommit: options.snapshot_commit,
    requestId: options.request_id,
  };
}

export async function runReleasePolicyCli(args, {
  write = console.log,
  previewGithub = previewGithubReleaseBaseline,
  enableGithub = enableGithubReleaseBaseline,
  previewTaskUpstream = null,
  enableTaskUpstream = null,
} = {}) {
  const [surface, action, ...rawOptions] = args;
  if (!["github-baseline", "task-upstream-adoption"].includes(surface)
      || !["preview", "enable"].includes(action)) {
    throw new Error(
      "Usage: npm run release:policy -- <github-baseline|task-upstream-adoption> <preview|enable> ...",
    );
  }
  const options = parseOptions(rawOptions);
  let result;
  if (surface === "github-baseline") {
    const input = githubBaselineInput(options);
    result = action === "preview"
      ? await previewGithub(input)
      : await enableGithub(input, { writeState: (state) => writePublicationState(state) });
  } else {
    const input = taskUpstreamAdoptionInput(options);
    let preview = previewTaskUpstream;
    let enable = enableTaskUpstream;
    if (!preview || !enable) {
      const config = await loadConfig();
      const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir: config.dataDir });
      preview ??= (value) => taskGitWorkspaces.previewExplicitUpstreamAdoption(value);
      enable ??= (value) => taskGitWorkspaces.recordExplicitUpstreamAdoption(value);
    }
    result = action === "preview" ? await preview(input) : await enable(input);
  }
  write(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleasePolicyCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
