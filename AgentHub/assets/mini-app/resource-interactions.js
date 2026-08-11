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

  function resourceActions(kind) {
    return kind === "link" ? ["open", "copy", "save"] : ["copy", "save"];
  }

  window.AgentHubResourceInteractions = {
    galleryIndex,
    imageGallery,
    isImageAttachment,
    moveGalleryIndex,
    resourceActions,
    viewerGallery,
  };
})();
