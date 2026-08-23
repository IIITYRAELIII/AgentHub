import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  attachmentIsImage,
  imageMatchesContentType,
  MAX_MESSAGE_ATTACHMENTS,
} from "../../domain/attachment-files.mjs";
import { AGENT_HUB_VERSION } from "./agent-hub-package.mjs";

const execFileAsync = promisify(execFile);

export const BUG_REPORTS_RELATIVE_ROOT = "AgentHub/Bugs";
export const MAX_BUG_REPORT_TEXT_CHARS = 20_000;

const REPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMAGE_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
]);

function cleanSource(value) {
  return String(value ?? "unknown").replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 80)
    || "unknown";
}

function normalizedGitPath(value) {
  return String(value ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function reportMarkdown({ text, source, submittedAt, screenshotNames }) {
  const description = String(text ?? "").trim() || "_Описание не добавлено._";
  return [
    "# Bug report",
    "",
    `- Submitted: ${submittedAt}`,
    `- Surface: ${cleanSource(source)}`,
    `- Agent Hub: ${AGENT_HUB_VERSION}`,
    "",
    "## Description",
    "",
    description,
    ...(screenshotNames.length
      ? ["", "## Screenshots", "", ...screenshotNames.map((name) => `- ${name}`)]
      : []),
    "",
  ].join("\n");
}

function reportFromMarkdown({ id, folder, markdown }) {
  const normalized = String(markdown ?? "").replace(/\r\n?/gu, "\n");
  const descriptionMarker = "## Description\n";
  const descriptionStart = normalized.indexOf(descriptionMarker);
  const screenshotsMarker = "\n## Screenshots\n";
  const screenshotsStart = normalized.lastIndexOf(screenshotsMarker);
  const descriptionEnd = screenshotsStart > descriptionStart ? screenshotsStart : normalized.length;
  const description = descriptionStart < 0
    ? ""
    : normalized.slice(descriptionStart + descriptionMarker.length, descriptionEnd).trim();
  const screenshots = screenshotsStart < 0
    ? 0
    : normalized.slice(screenshotsStart + screenshotsMarker.length)
      .split("\n")
      .filter((line) => /^-\s+\S/iu.test(line)).length;
  return {
    id,
    folder,
    text: description === "_Описание не добавлено._" ? "" : description,
    screenshots,
  };
}

async function defaultRunGit(repository, args) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = String(error?.stderr ?? error?.stdout ?? error?.message ?? error).trim();
    throw new Error(`Git ${args.join(" ")} завершился с ошибкой${detail ? `: ${detail}` : ""}`);
  }
}

function ancestors(value) {
  const result = [];
  let current = path.resolve(value);
  for (;;) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

export async function findUtilitiesRepository({
  agentHubRoot,
  projectRoots = [],
  runGit = defaultRunGit,
} = {}) {
  const candidates = [];
  const sourceRoot = path.resolve(String(agentHubRoot ?? "."));
  if (path.basename(sourceRoot).toLowerCase() === "agenthub") {
    candidates.push(path.dirname(sourceRoot));
  }
  for (const projectRoot of projectRoots) {
    if (!String(projectRoot ?? "").trim()) continue;
    for (const ancestor of ancestors(projectRoot)) candidates.push(path.join(ancestor, "Utilities"));
  }
  for (const candidate of [...new Set(candidates.map((value) => path.resolve(value)))]) {
    try {
      const { stdout } = await runGit(candidate, ["rev-parse", "--show-toplevel"]);
      if (path.resolve(stdout.trim()) !== candidate) continue;
      const info = await stat(path.join(candidate, "AgentHub", "package.json"));
      if (info.isFile()) return candidate;
    } catch {
      // A configured project may live outside the shared workspace. Try the next ancestor.
    }
  }
  throw new Error("Не найден рабочий репозиторий Utilities для публикации отчёта");
}

export class BugReportRepository {
  #agentHubRoot;
  #projectRoots;
  #repository;
  #runGit;
  #now;
  #randomUUID;

  constructor({
    agentHubRoot,
    projectRoots = [],
    repository = null,
    runGit = defaultRunGit,
    now = () => new Date(),
    createId = randomUUID,
  } = {}) {
    this.#agentHubRoot = path.resolve(String(agentHubRoot ?? "."));
    this.#projectRoots = projectRoots.map((value) => path.resolve(value));
    this.#repository = repository ? path.resolve(repository) : null;
    this.#runGit = runGit;
    this.#now = now;
    this.#randomUUID = createId;
  }

  async #git(...args) {
    const repository = await this.#resolveRepository();
    return this.#runGit(repository, args);
  }

  async #gitAt(repository, ...args) {
    return this.#runGit(repository, args);
  }

  async #resolveRepository() {
    this.#repository ??= await findUtilitiesRepository({
      agentHubRoot: this.#agentHubRoot,
      projectRoots: this.#projectRoots,
      runGit: this.#runGit,
    });
    return this.#repository;
  }

  async #publicationTarget() {
    const branch = (await this.#git("branch", "--show-current")).stdout.trim();
    if (branch !== "main") throw new Error("Отчёты о багах публикуются только из ветки main");
    const upstream = (await this.#git("rev-parse", "--abbrev-ref", "@{upstream}")).stdout.trim();
    const separator = upstream.indexOf("/");
    if (separator < 1 || separator === upstream.length - 1) {
      throw new Error("Для main не настроен upstream");
    }
    const remote = upstream.slice(0, separator);
    const remoteBranch = upstream.slice(separator + 1);
    await this.#git("fetch", "--quiet", remote);
    const upstreamHead = (await this.#git("rev-parse", "@{upstream}")).stdout.trim();
    return { upstreamHead, remote, remoteBranch };
  }

  async addedSince(revision = "") {
    const head = (await this.#git("rev-parse", "HEAD")).stdout.trim().toLowerCase();
    const previous = String(revision ?? "").trim().toLowerCase();
    let baseline = !/^[0-9a-f]{40,64}$/u.test(previous);
    if (!baseline) {
      try {
        await this.#git("cat-file", "-e", `${previous}^{commit}`);
      } catch {
        baseline = true;
      }
    }
    if (!baseline && previous === head) return { head, reports: [], baseline: false };
    const changed = (await this.#git(...(baseline
      ? ["ls-tree", "-r", "--name-only", "-z", head, "--", BUG_REPORTS_RELATIVE_ROOT]
      : ["diff", "--name-only", "--diff-filter=A", "-z", previous, head, "--", BUG_REPORTS_RELATIVE_ROOT]
    ))).stdout.split("\0").map(normalizedGitPath).filter(Boolean).sort();
    const reports = [];
    for (const reportFile of changed) {
      const match = /^AgentHub\/Bugs\/bug-([0-9a-f-]{36})\/report\.md$/iu.exec(reportFile);
      if (!match || !REPORT_ID_PATTERN.test(match[1])) continue;
      const folder = reportFile.slice(0, -"/report.md".length);
      const markdown = (await this.#git("show", `${head}:${reportFile}`)).stdout;
      reports.push(reportFromMarkdown({ id: match[1].toLowerCase(), folder, markdown }));
    }
    return { head, reports, baseline };
  }

  async submit({ text = "", screenshots = [], reportId = "", source = "unknown" } = {}) {
    const description = String(text ?? "").trim();
    if (description.length > MAX_BUG_REPORT_TEXT_CHARS) {
      throw new Error(`Описание бага не должно превышать ${MAX_BUG_REPORT_TEXT_CHARS} символов`);
    }
    if (!Array.isArray(screenshots) || screenshots.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new Error(`Можно приложить не более ${MAX_MESSAGE_ATTACHMENTS} скриншотов`);
    }
    if (!description && screenshots.length === 0) {
      throw new Error("Введите описание бага или приложите скриншот");
    }
    const id = String(reportId || this.#randomUUID()).trim().toLowerCase();
    if (!REPORT_ID_PATTERN.test(id)) throw new Error("Некорректный идентификатор отчёта");

    const prepared = [];
    for (const screenshot of screenshots) {
      const file = path.resolve(String(screenshot?.file ?? ""));
      const type = String(screenshot?.type ?? "").toLowerCase();
      if (!attachmentIsImage(type) || !IMAGE_EXTENSIONS.has(type)) {
        throw new Error("К отчёту можно приложить только изображения PNG, JPEG, WebP, GIF или BMP");
      }
      const body = await readFile(file);
      if (!imageMatchesContentType(body, type)) throw new Error("Один из скриншотов повреждён или имеет неверный формат");
      prepared.push({ file, type });
    }

    let stagingRoot = "";
    let publicationWorktree = "";
    let worktreeAdded = false;
    try {
      const target = await this.#publicationTarget();
      stagingRoot = await mkdtemp(path.join(tmpdir(), "agent-hub-bug-report-"));
      publicationWorktree = path.join(stagingRoot, "publish");
      await this.#git("worktree", "add", "--detach", publicationWorktree, target.upstreamHead);
      worktreeAdded = true;
      const relativeFolder = `${BUG_REPORTS_RELATIVE_ROOT}/bug-${id}`;
      const reportDirectory = path.join(publicationWorktree, ...relativeFolder.split("/"));
      const screenshotNames = prepared.map((item, index) => (
        `screenshot-${String(index + 1).padStart(2, "0")}${IMAGE_EXTENSIONS.get(item.type)}`
      ));
      const submittedAt = this.#now().toISOString();

      await mkdir(path.dirname(reportDirectory), { recursive: true });
      await mkdir(reportDirectory, { recursive: false });
      for (let index = 0; index < prepared.length; index += 1) {
        await copyFile(prepared[index].file, path.join(reportDirectory, screenshotNames[index]));
      }
      await writeFile(
        path.join(reportDirectory, "report.md"),
        reportMarkdown({ text: description, source, submittedAt, screenshotNames }),
        { encoding: "utf8", flag: "wx" },
      );

      await this.#gitAt(publicationWorktree, "add", "--", relativeFolder);
      await this.#gitAt(
        publicationWorktree,
        "-c", "artifactHooks.autoSync=off",
        "-c", "commit.gpgSign=false",
        "commit", "--only", "-m", `Add Agent Hub bug report ${id.slice(0, 8)}`,
        "--", relativeFolder,
      );
      const parent = (await this.#gitAt(publicationWorktree, "rev-parse", "HEAD^")).stdout.trim();
      const committedPaths = (await this.#gitAt(
        publicationWorktree,
        "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD",
      )).stdout.split("\0").filter(Boolean).map(normalizedGitPath);
      const reportPrefix = `${relativeFolder}/`;
      if (
        parent !== target.upstreamHead
        || committedPaths.length === 0
        || committedPaths.some((item) => !item.startsWith(reportPrefix))
      ) {
        throw new Error("Защитная проверка остановила push: commit содержит изменения вне папки отчёта");
      }
      await this.#gitAt(
        publicationWorktree,
        "push", "--porcelain", target.remote, `HEAD:refs/heads/${target.remoteBranch}`,
      );
      return {
        id,
        folder: relativeFolder,
        screenshots: screenshotNames.length,
        pushed: true,
      };
    } finally {
      if (worktreeAdded) {
        await this.#git("worktree", "remove", "--force", publicationWorktree).catch(() => {});
      }
      if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      await Promise.all(prepared.map(({ file }) => unlink(file).catch(() => {})));
    }
  }
}
