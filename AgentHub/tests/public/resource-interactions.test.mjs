import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../../assets/web-app/attachments/interactions.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(source, { window });
const interactions = window.AgentHubResourceInteractions;

test("image galleries retain image order and clamp navigation", () => {
  const first = { name: "one.png", type: "image/png" };
  const second = { name: "notes.txt", type: "text/plain" };
  const third = { name: "two.jpg", isImage: true };
  assert.deepEqual(interactions.imageGallery([first, second, third]).map((item) => item.name), [
    "one.png",
    "two.jpg",
  ]);
  assert.equal(interactions.moveGalleryIndex(0, -1, 2), 0);
  assert.equal(interactions.moveGalleryIndex(0, 1, 2), 1);
  assert.equal(interactions.moveGalleryIndex(1, 1, 2), 1);
});

test("missing attachment failures are recognized without exposing transport details", () => {
  assert.equal(interactions.unavailableAttachmentError(
    new Error("ENOENT: no such file or directory, stat 'C:\\\\Users\\\\name\\\\AgentHub\\\\attachments\\\\gone.png'"),
  ), true);
  assert.equal(interactions.unavailableAttachmentError(new Error("Миниатюра вложения недоступна: HTTP 404")), true);
  assert.equal(interactions.unavailableAttachmentError(new Error("Agent Hub не ответил вовремя")), false);
});

test("image viewer dismisses only direct backdrop and stage clicks", () => {
  const viewer = {};
  const stage = {};
  const image = {};
  const control = {};
  assert.equal(interactions.shouldDismissViewer(viewer, viewer, stage), true);
  assert.equal(interactions.shouldDismissViewer(stage, viewer, stage), true);
  assert.equal(interactions.shouldDismissViewer(image, viewer, stage), false);
  assert.equal(interactions.shouldDismissViewer(control, viewer, stage), false);
});

test("image viewer keeps controls theme-independent and scales small images", async () => {
  const styles = await readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.attachment-viewer img \{[\s\S]*?height: 100%;[\s\S]*?object-fit: contain;[\s\S]*?width: 100%;/u);
  assert.match(styles, /\.attachment-viewer-close \{[\s\S]*?border: 1px solid rgba\(244, 248, 250, 0\.72\);[\s\S]*?color: #f4f8fa;/u);
  assert.match(styles, /\.attachment-viewer-caption \{[\s\S]*?color: #f4f8fa;/u);
});

test("resource menus expose actions by resource kind", () => {
  assert.deepEqual([...interactions.resourceActions({ kind: "attachment" })], ["copy", "save"]);
  assert.deepEqual([...interactions.resourceActions({ kind: "link", href: "https://example.com" })], [
    "open",
    "copy",
    "save",
  ]);
  assert.deepEqual([...interactions.resourceActions({
    kind: "link",
    localPath: "D:/work/file.txt:12",
  })], [
    "open-editor", "reveal", "copy-path", "copy-object", "save",
  ]);
  assert.deepEqual([...interactions.resourceActions({
    kind: "link",
    localPath: "D:/work/file.txt:12",
  })], ["open-editor", "reveal", "copy-path", "copy-object", "save"]);
});

test("remote browsers offer a download instead of desktop-only file actions", () => {
  const resource = {
    kind: "link",
    localPath: "D:/work/handoff.md",
  };
  assert.deepEqual([...interactions.resourceActions(resource, {
    localWorkspaceFilesAvailable: false,
  })], ["save", "copy-path"]);
  assert.deepEqual([...interactions.resourceActions(resource, {
    localWorkspaceFilesAvailable: false,
    vscode: true,
  })], ["open-editor", "reveal", "copy-path", "copy-object", "save"]);
});

test("file references reject ambiguous Git refs but retain explicit file targets", () => {
  assert.equal(interactions.fileReferenceParts("origin/feature/mobile-links"), null);
  assert.equal(interactions.fileReferenceParts("agent/fix-links"), null);
  assert.equal(interactions.fileReferenceParts("https://github.com/acme/repo/tree/feature"), null);
  assert.deepEqual({ ...interactions.fileReferenceParts("src/app.js:42:7") }, {
    file: "src/app.js",
    line: 42,
    column: 7,
  });
  assert.deepEqual({ ...interactions.fileReferenceParts("../shared/README.md") }, {
    file: "../shared/README.md",
    line: 0,
    column: 0,
  });
  assert.deepEqual({ ...interactions.fileReferenceParts("D:/other/repo/file.mjs:8") }, {
    file: "D:/other/repo/file.mjs",
    line: 8,
    column: 0,
  });
  assert.deepEqual({ ...interactions.fileReferenceParts("</mnt/d/projects/example/video.mp4>") }, {
    file: "D:/projects/example/video.mp4",
    line: 0,
    column: 0,
  });
  assert.deepEqual({ ...interactions.fileReferenceParts("<file:///mnt/d/projects/example/video.mp4>") }, {
    file: "D:/projects/example/video.mp4",
    line: 0,
    column: 0,
  });
});

test("file resolver keeps absolute Windows paths independent from project roots", () => {
  const resolved = interactions.resolveFileReference(
    "C:\\Users\\example\\AppData\\Local\\AgentHub\\image.png:10:2",
    { basePath: "D:/projects/Utilities" },
  );
  assert.equal(resolved.absolutePath, "C:/Users/example/AppData/Local/AgentHub/image.png");
  assert.equal(resolved.localPath, "C:/Users/example/AppData/Local/AgentHub/image.png:10:2");
  assert.deepEqual([...resolved.candidates], ["C:/Users/example/AppData/Local/AgentHub/image.png"]);
});

test("file resolver maps WSL video links to local Windows workspace files", () => {
  const resolved = interactions.resolveFileReference(
    "</mnt/d/projects/example/artifacts/document-flow/autodoc/20260101-120000-example/Пример_проверки_маршрута.mp4>",
    { basePath: "D:/projects/Utilities" },
  );
  assert.equal(
    resolved.absolutePath,
    "D:/projects/example/artifacts/document-flow/autodoc/20260101-120000-example/Пример_проверки_маршрута.mp4",
  );
  assert.equal(resolved.localPath, resolved.absolutePath);
  assert.deepEqual([...resolved.candidates], [resolved.absolutePath]);
});

test("file resolver expands relative references across known workspace roots", () => {
  const resolved = interactions.resolveFileReference("src/app.js:42", {
    basePath: "D:/projects/Utilities",
    projectRoot: "D:/projects/Utilities",
    workspaceRoots: ["D:/projects/Utilities", "D:/projects/AgentHub"],
  });
  assert.equal(resolved.localPath, "D:/projects/Utilities/src/app.js:42");
  assert.deepEqual([...resolved.candidates], [
    "D:/projects/Utilities/src/app.js",
    "D:/projects/AgentHub/src/app.js",
  ]);
});

test("file resolver avoids fake project paths for home-relative references", () => {
  assert.equal(interactions.resolveFileReference("AppData/Local/AgentHub/image.png", {
    basePath: "D:/projects/Utilities",
  }), null);

  const resolved = interactions.resolveFileReference("Downloads/report.pdf", {
    basePath: "D:/projects/Utilities",
    homePath: "C:/Users/example",
  });
  assert.equal(resolved.localPath, "C:/Users/example/Downloads/report.pdf");
  assert.deepEqual([...resolved.candidates], ["C:/Users/example/Downloads/report.pdf"]);
});

test("local link clicks and context menus share one resource contract", () => {
  const resource = interactions.linkResource({
    href: "#",
    localPath: "D:/work/file.txt:12",
    name: " file.txt ",
  });
  assert.deepEqual({ ...resource }, {
    kind: "link",
    href: "#",
    localPath: "D:/work/file.txt:12",
    name: "file.txt",
  });
  assert.deepEqual([...interactions.resourceActions(resource)], [
    "open-editor", "reveal", "copy-path", "copy-object", "save",
  ]);
});

test("workspace file actions are available only in VS Code and local web", () => {
  assert.equal(interactions.localWorkspaceFilesAvailable({ vscode: true }), true);
  assert.equal(interactions.localWorkspaceFilesAvailable({
    protocol: "http:", hostname: "127.0.0.1",
  }), true);
  assert.equal(interactions.localWorkspaceFilesAvailable({
    protocol: "https:", hostname: "localhost",
  }), true);
  assert.equal(interactions.localWorkspaceFilesAvailable({
    protocol: "https:", hostname: "hub.example.com",
  }), false);
});

test("workspace file reveal tries the runtime before paired device bridge", async () => {
  const calls = [];
  const result = await interactions.revealWorkspaceFileResource({
    target: "D:/work/report.pdf",
    localWorkspaceFilesAvailable: false,
    remoteWorkspaceFileBridgeAvailable: true,
    revealOnServer: async (target) => calls.push(["server", target]),
    launchWorkspaceFileBridge: async (action, target) => calls.push(["bridge", action, target]),
  });

  assert.equal(result, "server");
  assert.deepEqual(calls, [["server", "D:/work/report.pdf"]]);
});

test("workspace file reveal falls back to paired device bridge only when runtime reveal is unavailable", async () => {
  const calls = [];
  const result = await interactions.revealWorkspaceFileResource({
    target: "D:/work/report.pdf",
    localWorkspaceFilesAvailable: false,
    remoteWorkspaceFileBridgeAvailable: true,
    revealOnServer: async (target) => {
      calls.push(["server", target]);
      const error = new Error("HTTP 503");
      error.code = "workspace-file-reveal-unavailable";
      throw error;
    },
    launchWorkspaceFileBridge: async (action, target) => calls.push(["bridge", action, target]),
  });

  assert.equal(result, "bridge");
  assert.deepEqual(calls, [
    ["server", "D:/work/report.pdf"],
    ["bridge", "reveal", "D:/work/report.pdf"],
  ]);
});

test("workspace file reveal does not bridge after runtime reveal rejects the file", async () => {
  const calls = [];
  await assert.rejects(
    interactions.revealWorkspaceFileResource({
      target: "D:/work/missing.pdf",
      localWorkspaceFilesAvailable: false,
      remoteWorkspaceFileBridgeAvailable: true,
      revealOnServer: async (target) => {
        calls.push(["server", target]);
        const error = new Error("Некорректный путь файла Workspace");
        error.code = "workspace-file-reveal-failed";
        throw error;
      },
      launchWorkspaceFileBridge: async (action, target) => calls.push(["bridge", action, target]),
    }),
    /Некорректный путь файла Workspace/u,
  );

  assert.deepEqual(calls, [["server", "D:/work/missing.pdf"]]);
});

test("workspace file reveal reports remote-device setup only after runtime unavailability", async () => {
  const calls = [];
  await assert.rejects(
    interactions.revealWorkspaceFileResource({
      target: "D:/work/report.pdf",
      localWorkspaceFilesAvailable: false,
      remoteWorkspaceFileBridgeAvailable: false,
      revealOnServer: async (target) => {
        calls.push(["server", target]);
        const error = new Error("HTTP 503");
        error.code = "workspace-file-reveal-unavailable";
        throw error;
      },
    }),
    /режима удалённого устройства/u,
  );

  assert.deepEqual(calls, [["server", "D:/work/report.pdf"]]);
});

test("VS Code image galleries use decorated resource URLs without fetching them", () => {
  const attachment = {
    id: "message-1.png",
    name: "one.png",
    type: "image/png",
    url: "vscode-webview://attachment/message-1.png",
  };
  const [browserImage] = interactions.viewerGallery([attachment], false);
  const [webviewImage] = interactions.viewerGallery([attachment], true);
  assert.equal(browserImage, attachment);
  assert.equal(webviewImage.dataUrl, attachment.url);
  assert.equal(attachment.dataUrl, undefined);
  assert.equal(interactions.attachmentPreviewSource(attachment, true), attachment.url);
  assert.equal(interactions.attachmentPreviewSource(attachment, false), "");
});
