import { pathToFileURL } from "node:url";
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

export async function runReleasePolicyCli(args, {
  write = console.log,
  previewGithub = previewGithubReleaseBaseline,
  enableGithub = enableGithubReleaseBaseline,
} = {}) {
  const [surface, action, ...rawOptions] = args;
  if (surface !== "github-baseline" || !["preview", "enable"].includes(action)) {
    throw new Error(
      "Usage: npm run release:policy -- github-baseline <preview|enable> "
      + "--project-root <path> --owner <owner> --repo <repo> --tag <tag> "
      + "--release-id <id> --target-commit <sha>",
    );
  }
  const options = parseOptions(rawOptions);
  const input = githubBaselineInput(options);
  const result = action === "preview"
    ? await previewGithub(input)
    : await enableGithub(input, { writeState: (state) => writePublicationState(state) });
  write(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleasePolicyCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
