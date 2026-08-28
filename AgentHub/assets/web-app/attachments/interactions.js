"use strict";

(() => {
  const knownFileExtensions = new Set([
    "bsl", "c", "cfe", "cf", "cmd", "cpp", "cs", "csproj", "css", "docx", "epf", "erf",
    "go", "h", "html", "ini", "java", "jpeg", "jpg", "js", "json", "jsx", "md", "mjs",
    "pdf", "php", "png", "ps1", "py", "rb", "rs", "sh", "sql", "svg", "toml", "ts", "tsx",
    "txt", "xml", "yaml", "yml",
  ]);
  const homeRelativeFolders = new Set([
    "appdata", "desktop", "documents", "downloads", "music", "pictures", "videos",
  ]);

  function windowsPathAbsolute(raw) {
    return /^\/?[A-Za-z]:[\\/]/u.test(String(raw ?? "").trim());
  }

  function normalizeWindowsPath(raw) {
    const source = String(raw ?? "").trim()
      .replace(/^\/(?=[A-Za-z]:[\\/])/u, "")
      .replaceAll("\\", "/");
    const match = source.match(/^([A-Za-z]):\/(.*)$/u);
    if (!match) return "";
    const segments = [];
    for (const segment of match[2].split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!segments.length) return "";
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
    return `${match[1].toUpperCase()}:/${segments.join("/")}`;
  }

  function appendUniquePath(paths, value) {
    const path = normalizeWindowsPath(value);
    if (!path) return;
    const key = path.toLowerCase();
    if (paths.some((entry) => entry.toLowerCase() === key)) return;
    paths.push(path);
  }

  function appendContextPath(paths, value) {
    if (Array.isArray(value)) {
      for (const item of value) appendContextPath(paths, item);
      return;
    }
    appendUniquePath(paths, value);
  }

  function fileReferenceBases(context = {}) {
    const paths = [];
    appendContextPath(paths, context.basePath);
    appendContextPath(paths, context.sessionCwd);
    appendContextPath(paths, context.projectRoot);
    appendContextPath(paths, context.workspaceRoots);
    appendContextPath(paths, context.projectRoots);
    appendContextPath(paths, context.roots);
    return paths;
  }

  function normalizedRelativeFile(file) {
    return String(file ?? "").trim().replaceAll("\\", "/").replace(/^\/+/u, "");
  }

  function homeRelativePath(file) {
    const normalized = normalizedRelativeFile(file);
    const first = normalized.split("/")[0]?.toLowerCase() ?? "";
    return homeRelativeFolders.has(first);
  }

  function resolveFileReference(raw, context = {}) {
    const reference = fileReferenceParts(raw);
    if (!reference) return null;
    const absolute = windowsPathAbsolute(reference.file);
    const candidates = [];
    if (absolute) {
      appendUniquePath(candidates, reference.file);
    } else if (homeRelativePath(reference.file) && !/^\.{1,2}[\\/]/u.test(reference.file)) {
      const homePath = normalizeWindowsPath(context.homePath ?? context.userProfile ?? "");
      if (homePath) appendUniquePath(candidates, `${homePath}/${normalizedRelativeFile(reference.file)}`);
    } else {
      for (const base of fileReferenceBases(context)) {
        appendUniquePath(candidates, `${base}/${normalizedRelativeFile(reference.file)}`);
      }
    }
    if (!candidates.length) return null;
    const location = reference.line
      ? `:${reference.line}${reference.column ? `:${reference.column}` : ""}`
      : "";
    return {
      ...reference,
      absolutePath: candidates[0],
      candidates,
      displayPath: reference.file,
      localPath: `${candidates[0]}${location}`,
    };
  }

  function fileReferenceParts(raw) {
    const source = String(raw ?? "").trim();
    const value = source.startsWith("<") && source.endsWith(">")
      ? source.slice(1, -1).trim()
      : source;
    if (!value || /^(?:https?|vscode):/iu.test(value)) return null;
    const positioned = value.match(/^(?<file>.+):(?<line>[1-9][0-9]*):(?<column>[1-9][0-9]*)$/u)
      ?? value.match(/^(?<file>.+):(?<line>[1-9][0-9]*)$/u);
    const file = String(positioned?.groups?.file ?? value).trim();
    const absolute = windowsPathAbsolute(file);
    const explicitlyRelative = /^\.{1,2}[\\/]/u.test(file);
    const name = file.replaceAll("\\", "/").split("/").at(-1) ?? "";
    const extension = name.match(/\.([^./\\\s:]+)$/u)?.[1]?.toLowerCase() ?? "";
    const recognizableFile = knownFileExtensions.has(extension);
    if (!file || (!absolute && !explicitlyRelative && !positioned && !recognizableFile)) return null;
    return {
      file,
      line: Number(positioned?.groups?.line) || 0,
      column: Number(positioned?.groups?.column) || 0,
    };
  }

  function isImageAttachment(value) {
    return Boolean(value?.isImage)
      || String(value?.type ?? "").toLowerCase().startsWith("image/");
  }

  function unavailableAttachmentError(error) {
    if (error?.attachmentUnavailable === true) return true;
    const code = String(error?.code ?? "").trim().toUpperCase();
    const message = String(error?.message ?? error ?? "").trim();
    return code === "ENOENT"
      || /\bENOENT\b/iu.test(message)
      || /\bHTTP 404\b/iu.test(message)
      || /(?:Файл|Миниатюра|Вложение)[^\r\n]*(?:недоступ|не найден)/iu.test(message);
  }

  function imageGallery(values) {
    return (Array.isArray(values) ? values : []).filter(isImageAttachment);
  }

  function attachmentPreviewSource(value, preferResourceUrl = false) {
    return String(
      value?.thumbnailUrl
      ?? value?.dataUrl
      ?? (preferResourceUrl ? value?.url : "")
      ?? "",
    ).trim();
  }

  function viewerGallery(values, preferResourceUrl = false) {
    return imageGallery(values).map((item) => {
      const resourceUrl = String(item?.url ?? "").trim();
      if (!preferResourceUrl || !resourceUrl || item?.dataUrl) return item;
      return { ...item, dataUrl: resourceUrl };
    });
  }

  function galleryIndex(value, length) {
    if (!Number.isFinite(Number(value)) || length <= 0) return 0;
    return Math.min(length - 1, Math.max(0, Math.trunc(Number(value))));
  }

  function moveGalleryIndex(index, direction, length) {
    const current = galleryIndex(index, length);
    if (direction < 0) return Math.max(0, current - 1);
    if (direction > 0) return Math.min(Math.max(0, length - 1), current + 1);
    return current;
  }

  function shouldDismissViewer(target, viewer, stage) {
    return target === viewer || target === stage;
  }

  function linkResource({ href = "", localPath = "", name = "" } = {}) {
    return {
      kind: "link",
      href: String(href),
      localPath: String(localPath),
      name: String(name).trim() || String(href),
    };
  }

  function resourceActions(resource, { canCopyLocalObject = false } = {}) {
    if (resource?.kind !== "link") return ["copy", "save"];
    if (String(resource?.localPath ?? "").trim()) {
      return canCopyLocalObject
        ? ["open-editor", "reveal", "copy-path", "copy-object", "save"]
        : ["open-editor", "copy-path", "save"];
    }
    return ["open", "copy", "save"];
  }

  function inlineResourceActions(resource, { canRevealLocalObject = false } = {}) {
    if (resource?.kind !== "link") return [];
    if (!String(resource?.localPath ?? "").trim() || !canRevealLocalObject) return [];
    return ["reveal"];
  }

  function localWorkspaceFilesAvailable({ vscode = false, protocol = "", hostname = "" } = {}) {
    if (vscode) return true;
    return ["http:", "https:"].includes(String(protocol).toLowerCase())
      && ["127.0.0.1", "localhost", "::1"].includes(String(hostname).toLowerCase());
  }

  window.AgentHubResourceInteractions = {
    attachmentPreviewSource,
    fileReferenceParts,
    fileReferenceBases,
    galleryIndex,
    imageGallery,
    inlineResourceActions,
    isImageAttachment,
    linkResource,
    localWorkspaceFilesAvailable,
    moveGalleryIndex,
    normalizeWindowsPath,
    resourceActions,
    resolveFileReference,
    shouldDismissViewer,
    unavailableAttachmentError,
    viewerGallery,
    windowsPathAbsolute,
  };
})();
