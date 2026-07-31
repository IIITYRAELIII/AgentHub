"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AgentHubBridge, webviewHttpMessages } = require("./agent-hub-bridge.js");

function day(date, turnId) {
  return "<details data-work-log-day-section>"
    + `<summary data-work-log-day><strong>${date}</strong></summary>`
    + `<div data-work-log-turn-entry data-work-log-turn-id="${turnId}">`
    + "<details data-work-log-turn-details>"
    + `<summary>Ход ${turnId}</summary>`
    + `<div data-work-log-turn-expanded>Ответ ${turnId}</div>`
    + "</details></div></details>";
}

test("VS Code bridge serves the same lazy journal contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-bridge-"));
  try {
    const journalFile = path.join(root, "WORK_LOG.md");
    await writeFile(journalFile, [
      "# Журнал",
      day("06.07.2026", "turn-1"),
      day("05.07.2026", "turn-2"),
      day("04.07.2026", "turn-3"),
      day("03.07.2026", "turn-4"),
      day("02.07.2026", "turn-5"),
      day("01.07.2026", "turn-6"),
    ].join("\n"), "utf8");
    const bridge = new AgentHubBridge({
      journalFile,
      moduleRoot: path.resolve(__dirname, ".."),
    });
    const initial = await bridge.http({ path: "/api/journal" });
    assert.equal(initial.status, 200);
    const payload = JSON.parse(initial.body);
    assert.match(payload.html, /Ответ turn-1/u);
    assert.doesNotMatch(payload.html, /Ответ turn-6/u);

    const older = await bridge.http({
      path: `/api/journal/day?date=01.07.2026&version=${encodeURIComponent(payload.version)}`,
    });
    assert.equal(older.status, 200);
    assert.match(JSON.parse(older.body).html, /Ход turn-6/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge stages pasted images in the allowed runtime directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-image-"));
  const previousRoot = process.env.AGENT_HUB_RUNTIME_ROOT;
  try {
    process.env.AGENT_HUB_RUNTIME_ROOT = root;
    const bridge = new AgentHubBridge({
      journalFile: path.join(root, "WORK_LOG.md"),
      runtimeRoot: root,
    });
    const body = Buffer.from("test-image");
    const target = await bridge.control("upload-attachment", {
      type: "image/png",
      dataUrl: `data:image/png;base64,${body.toString("base64")}`,
    });
    assert.equal(path.dirname(target), path.join(root, "DesktopApp", "attachments"));
    assert.deepEqual(await readFile(target), body);
    assert.equal(await bridge.attachmentPath(path.basename(target)), target);
    await assert.rejects(bridge.attachmentPath("../outside.png"), /идентификатор/u);
  } finally {
    if (previousRoot == null) delete process.env.AGENT_HUB_RUNTIME_ROOT;
    else process.env.AGENT_HUB_RUNTIME_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("installed VS Code bridge resolves backend modules from the active runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-runtime-"));
  try {
    const release = "test-release";
    const releaseRoot = path.join(root, "releases", release);
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(path.join(root, "current.json"), JSON.stringify({ current: release }), "utf8");
    await writeFile(path.join(releaseRoot, "desktop-control.mjs"), [
      "export async function callDesktopControl(action, params) {",
      "  return { action, params, installedLayout: true };",
      "}",
    ].join("\n"), "utf8");
    const bridge = new AgentHubBridge({
      journalFile: path.join(root, "WORK_LOG.md"),
      runtimeRoot: root,
    });
    assert.deepEqual(await bridge.control("snapshot", { sample: 1 }), {
      action: "snapshot",
      params: { sample: 1 },
      installedLayout: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge answers the rate-limit summary without the journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-vscode-limits-"));
  try {
    const journalFile = path.join(root, "WORK_LOG.md");
    await writeFile(journalFile, [
      "# Журнал",
      '<div data-work-log-rate-limits data-sampled-at="2026-07-30T02:55:14.512Z">'
        + "<span data-rate-limit-caption>Лимиты</span>"
        + "<span data-rate-limit><span data-rate-limit-name>CODEX</span>"
        + "<span data-rate-limit-value>75.0%</span></span></div>",
      day("06.07.2026", "turn-1"),
    ].join("\n"), "utf8");
    const bridge = new AgentHubBridge({
      journalFile,
      moduleRoot: path.resolve(__dirname, ".."),
    });
    const response = await bridge.http({ path: "/api/rate-limits" });
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.match(payload.html, /CODEX/u);
    assert.equal(payload.sampledAt, "2026-07-30T02:55:14.512Z");
    // шапке отдаётся только сводка, дни в ответ не попадают
    assert.doesNotMatch(payload.html, /data-work-log-day-section/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VS Code bridge chunks a large journal response for webview IPC", () => {
  const body = JSON.stringify({ html: "Ж".repeat(1_500_000) });
  const messages = webviewHttpMessages("request-1", {
    status: 200,
    headers: { ETag: '"large"' },
    body,
  });
  assert.equal(messages[0].type, "agenthub:http-start");
  assert.equal(messages.at(-1).type, "agenthub:http-result");
  assert.equal(messages.at(-1).chunked, true);
  assert.ok(messages.length > 3);
  const chunks = messages.filter((message) => message.type === "agenthub:http-chunk");
  assert.equal(chunks.length, messages[0].chunkCount);
  assert.equal(chunks.map((message) => message.body).join(""), body);
  assert.ok(chunks.every((message) => message.body.length <= 192 * 1024));
});
