"use strict";

(() => {
  const knownFileExtensions = new Set([
    "bsl", "c", "cfe", "cf", "cmd", "cpp", "cs", "csproj", "css", "docx", "epf", "erf",
    "go", "h", "html", "ini", "java", "jpeg", "jpg", "js", "json", "jsx", "md", "mjs",
    "pdf", "php", "png", "ps1", "py", "rb", "rs", "sh", "sql", "svg", "toml", "ts", "tsx",
    "txt", "xml", "yaml", "yml",
  ]);

  function fileReferenceParts(raw) {
    const source = String(raw ?? "").trim();
    const value = source.startsWith("<") && source.endsWith(">")
      ? source.slice(1, -1).trim()
      : source;
    if (!value || /^(?:https?|vscode):/iu.test(value)) return null;
    const positioned = value.match(/^(?<file>.+):(?<line>[1-9][0-9]*):(?<column>[1-9][0-9]*)$/u)
      ?? value.match(/^(?<file>.+):(?<line>[1-9][0-9]*)$/u);
    const file = String(positioned?.groups?.file ?? value).trim();
    const absolute = /^\/?[A-Za-z]:[\\/]/u.test(file);
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

  function imageGallery(values) {
    return (Array.isArray(values) ? values : []).filter(isImageAttachment);
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

  function localWorkspaceFilesAvailable({ vscode = false, protocol = "", hostname = "" } = {}) {
    if (vscode) return true;
    return ["http:", "https:"].includes(String(protocol).toLowerCase())
      && ["127.0.0.1", "localhost", "::1"].includes(String(hostname).toLowerCase());
  }

  window.AgentHubResourceInteractions = {
    fileReferenceParts,
    galleryIndex,
    imageGallery,
    isImageAttachment,
    linkResource,
    localWorkspaceFilesAvailable,
    moveGalleryIndex,
    resourceActions,
    shouldDismissViewer,
    viewerGallery,
  };
})();
