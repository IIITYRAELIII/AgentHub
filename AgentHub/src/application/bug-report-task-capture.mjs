import { TASK_DESCRIPTION_MAX_LENGTH } from "../domain/task-board-task.mjs";

const DEFAULT_BUG_REPORT_TITLE = "Разобрать баг-репорт Agent Hub";

function normalizedWorkspaceName(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
}

export function bugReportTaskText({ id, folder, text } = {}) {
  const reportId = String(id ?? "").trim().toLowerCase();
  const reportFolder = String(folder ?? "").replace(/\\/gu, "/").replace(/\/+$/gu, "").trim();
  if (!reportId || !reportFolder) throw new Error("Bug report id and folder are required");
  const reportReference = `Отчёт: ${reportFolder}/report.md`;
  const suffix = `\n\n${reportReference}`;
  const fallback = reportId ? `${DEFAULT_BUG_REPORT_TITLE} ${reportId.slice(0, 8)}` : DEFAULT_BUG_REPORT_TITLE;
  const description = String(text ?? "").replace(/\r\n?/gu, "\n").trim() || fallback;
  const available = TASK_DESCRIPTION_MAX_LENGTH - suffix.length;
  const clipped = description.length <= available
    ? description
    : `${description.slice(0, Math.max(1, available - 1)).trimEnd()}…`;
  return `${clipped}${suffix}`;
}

export class BugReportTaskCapture {
  constructor({ taskBoard, workspaceName = "", reports = null, cursorStore = null } = {}) {
    this.taskBoard = taskBoard;
    this.workspaceName = String(workspaceName ?? "").replace(/\s+/gu, " ").trim();
    this.reports = reports;
    this.cursorStore = cursorStore;
    this.scanPromise = null;
    if (this.workspaceName && (
      typeof taskBoard?.create !== "function"
      || typeof taskBoard?.workspaces !== "function"
      || typeof taskBoard?.move !== "function"
    )) {
      throw new TypeError("taskBoard is required for bug report capture");
    }
  }

  get enabled() {
    return Boolean(this.workspaceName);
  }

  async capture(report, { text = "" } = {}) {
    if (!this.workspaceName) return null;
    const id = String(report?.id ?? "").trim().toLowerCase();
    const folder = String(report?.folder ?? "").trim();
    const reportFile = `${folder.replace(/\\/gu, "/").replace(/\/+$/gu, "")}/report.md`;
    const operation = async () => {
      const task = await this.taskBoard.create({
        text: bugReportTaskText({ id, folder, text }),
        source: "bug-report",
        sourceKey: `bug-report:${id}`,
        sourceDetails: {
          bugReportId: id,
          folder,
          reportFile,
          screenshots: Math.max(0, Number(report?.screenshots) || 0),
        },
      });
      const expectedName = normalizedWorkspaceName(this.workspaceName);
      const workspace = this.taskBoard.workspaces().find((item) => (
        normalizedWorkspaceName(item?.name) === expectedName
      ));
      if (!workspace) return task;
      return this.taskBoard.move({ id: task.id, bucket: "workspace", workspaceId: workspace.id });
    };
    return operation();
  }

  scan() {
    if (!this.enabled) return Promise.resolve({ captured: 0, baseline: false });
    if (
      typeof this.reports?.addedSince !== "function"
      || typeof this.cursorStore?.load !== "function"
      || typeof this.cursorStore?.save !== "function"
    ) {
      return Promise.reject(new TypeError("reports and cursorStore are required for bug report synchronization"));
    }
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.#scan().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  async #scan() {
    const revision = await this.cursorStore.load();
    const batch = await this.reports.addedSince(revision);
    for (const report of batch.reports) await this.capture(report, { text: report.text });
    await this.cursorStore.save(batch.head);
    return { captured: batch.reports.length, baseline: Boolean(batch.baseline), head: batch.head };
  }
}
