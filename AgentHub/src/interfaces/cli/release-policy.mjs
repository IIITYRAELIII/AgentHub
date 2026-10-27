import { pathToFileURL } from "node:url";
import { loadConfig } from "../../infrastructure/filesystem/config.mjs";
import { TaskGitWorkspaceService } from "../../infrastructure/filesystem/task-git-workspace.mjs";
import { enableGithubReleaseBaseline, previewGithubReleaseBaseline } from "../../infrastructure/persistence/github-publication-baseline.mjs";
import {
  enableLocalPublicationReceiptBaseline,
  previewLocalPublicationReceiptBaseline,
} from "../../infrastructure/persistence/local-publication-receipt-baseline.mjs";
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
  if (options.source_only !== undefined) {
    if (options.source_only !== "true") throw new Error("Source bootstrap requires explicit --source-only true");
    const allowed = new Set(["source_only", "project_root", "owner", "repo", "target_commit", "source_tree", "request_id"]);
    if (Object.keys(options).some(key => !allowed.has(key))) throw new Error("Source bootstrap cannot include release/adoption arguments");
    return { kind: "source-bootstrap", projectRoot: options.project_root, owner: options.owner, repo: options.repo,
      expectedTargetCommit: options.target_commit, expectedTree: options.source_tree, requestId: options.request_id };
  }
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

function localPublicationReceiptInput(options) {
  return {
    projectRoot: options.project_root,
    workspaceId: options.workspace_id,
    runId: options.run_id,
    expectedRevision: options.revision,
    expectedGeneration: options.generation,
    expectedPublishedAt: options.published_at,
    expectedStateSha256: options.state_sha256,
    expectedReceiptSha256: options.receipt_sha256,
    expectedReleaseId: options.release_id,
    expectedOriginUrl: options.origin,
    expectedOriginMainCommit: options.origin_main,
    requestId: options.request_id,
  };
}

function acceptedMainBootstrapInput(options) {
  return {
    projectRoot: options.project_root,
    acceptedMainCommit: options.accepted_main,
    expectedDevCommit: options.expected_dev,
    publishedRevision: options.published_revision,
    expectedPublicationGeneration: options.published_generation,
    expectedMergeBaseCommit: options.merge_base,
    requestId: options.request_id,
    reviewedChangelogFile: options.reviewed_changelog_file ?? null,
    expectedResolvedTree: options.resolved_tree ?? null,
  };
}

export async function runReleasePolicyCli(args, {
  write = console.log,
  previewGithub = previewGithubReleaseBaseline,
  enableGithub = enableGithubReleaseBaseline,
  previewLocalPublication = previewLocalPublicationReceiptBaseline,
  enableLocalPublication = enableLocalPublicationReceiptBaseline,
  previewTaskUpstream = null,
  enableTaskUpstream = null,
  enableDevBootstrap = null,
} = {}) {
  const [surface, action, ...rawOptions] = args;
  if (!["github-baseline", "local-publication-receipt", "task-upstream-adoption", "task-dev-bootstrap"].includes(surface)
      || !["preview", "enable"].includes(action)
      || (surface === "task-dev-bootstrap" && action !== "enable")) {
    throw new Error(
      "Usage: npm run release:policy -- <github-baseline|local-publication-receipt|task-upstream-adoption> <preview|enable> ...; task-dev-bootstrap enable ...",
    );
  }
  const options = parseOptions(rawOptions);
  let result;
  if (surface === "github-baseline") {
    const input = githubBaselineInput(options);
    result = action === "preview"
      ? await previewGithub(input)
      : await enableGithub(input, { writeState: (state) => writePublicationState(state) });
  } else if (surface === "local-publication-receipt") {
    const input = localPublicationReceiptInput(options);
    result = action === "preview"
      ? await previewLocalPublication(input)
      : await enableLocalPublication(input, { writeState: (state) => writePublicationState(state) });
  } else if (surface === "task-dev-bootstrap") {
    const input = acceptedMainBootstrapInput(options);
    let enable = enableDevBootstrap;
    if (!enable) {
      const config = await loadConfig();
      const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir: config.dataDir });
      enable = (value) => taskGitWorkspaces.bootstrapAcceptedMainIntoDev(value);
    }
    result = await enable(input);
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
