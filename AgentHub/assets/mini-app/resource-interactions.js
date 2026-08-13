"use strict";

(() => {
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
      return canCopyLocalObject ? ["open", "copy-object", "save"] : ["open", "save"];
    }
    return ["open", "copy", "save"];
  }

  function localWorkspaceFilesAvailable({ vscode = false, protocol = "", hostname = "" } = {}) {
    if (vscode) return true;
    return ["http:", "https:"].includes(String(protocol).toLowerCase())
      && ["127.0.0.1", "localhost", "::1"].includes(String(hostname).toLowerCase());
  }

  window.AgentHubResourceInteractions = {
    galleryIndex,
    imageGallery,
    isImageAttachment,
    linkResource,
    localWorkspaceFilesAvailable,
    moveGalleryIndex,
    resourceActions,
    viewerGallery,
  };
})();
