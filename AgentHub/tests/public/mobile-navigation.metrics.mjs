export async function measureDrawerContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const values = [...context.getImageData(0, 0, 1, 1).data]; values[3] /= 255; return values;
    };
    const over = (a, b) => [...a.slice(0, 3).map((c, i) => c * a[3] + b[i] * (1 - a[3])), 1];
    const bg = (node) => {
      if (!node) return rgba(getComputedStyle(document.documentElement).getPropertyValue("--bg"));
      const color = rgba(getComputedStyle(node).backgroundColor);
      return color[3] === 1 ? color : over(color, bg(node.parentElement));
    };
    const luminance = (channels) => channels.slice(0, 3).map((c) => c / 255)
      .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    const drawer = document.querySelector("[data-mobile-workspace-drawer]");
    const selectors = [".mobile-navigation-head strong", ".task-rail-title > span:first-child",
      ".task-count", "[data-task-filter]", ".task-workspace-name", ".task-workspace-folder-name",
      ".task-workspace-folder-count", "[data-mobile-workspace-edit]", "[data-mobile-folder-rename]",
      ".mobile-workspace-footer button", ".mobile-workspace-footer svg", ".mobile-navigation-head button", ".task-workspace-folder-glyph"];
    const results = [];
    for (const selector of selectors) for (const node of drawer.querySelectorAll(selector)) {
      if (!node.getClientRects().length || node.closest("[hidden]")) continue;
      const style = getComputedStyle(node);
      const color = rgba(style.color); color[3] *= Number(style.opacity);
      results.push({ selector, minimum: selector.includes("edit]") || selector.includes("rename]") || selector.includes("glyph") || selector.includes("svg") ? 3 : 4.5,
        foreground: style.color, background: bg(node), ratio: ratio(over(color, bg(node)), bg(node)) });
      if (node.matches("input")) {
        const placeholder = getComputedStyle(node, "::placeholder");
        const c = rgba(placeholder.color); c[3] *= Number(placeholder.opacity);
        results.push({ selector: "search-placeholder", minimum: 4.5,
          foreground: placeholder.color, background: bg(node), ratio: ratio(over(c, bg(node)), bg(node)) });
        results.push({ selector: "search-border", minimum: 3, ratio: ratio(over(rgba(getComputedStyle(node.closest(".task-search")).borderTopColor), bg(node)), bg(node)) });
      }
    }
    const focused = document.activeElement;
    if (drawer.contains(focused)) {
      const s = getComputedStyle(focused);
      results.push({ selector: "focus-indicator", minimum: 3, width: parseFloat(s.outlineWidth),
        ratio: ratio(over(rgba(s.outlineColor), bg(focused)), bg(focused)) });
    }
    const selected = drawer.querySelector(".task-workspace-item[data-selected]");
    if (selected) results.push({ selector: "selected-marker", minimum: 3,
      ratio: ratio(over(rgba(getComputedStyle(selected).borderLeftColor), bg(selected)), bg(selected)) });
    const scrim = rgba(getComputedStyle(drawer, "::backdrop").backgroundColor);
    const geometry = [...drawer.querySelectorAll(".task-workspace-item, .task-workspace-folder-summary")]
      .filter((node) => node.getClientRects().length).map((node) => {
        const box = node.getBoundingClientRect(); const glyph = node.matches("summary")
          ? node.closest("[data-mobile-folder-row]")?.querySelector("[data-mobile-folder-rename]") : node.querySelector("[data-mobile-workspace-edit]");
        const button = glyph?.getBoundingClientRect(), svg = glyph?.querySelector("svg")?.getBoundingClientRect();
        const badge = node.querySelector(".task-workspace-folder-count")?.getBoundingClientRect();
        return { folder: node.matches("summary"), height: box.height,
          target: button ? [button.width, button.height] : null,
          glyph: svg ? [svg.width, svg.height] : null, badgeClear: !badge || !button || badge.right <= button.left,
          sameLine: !button || (button.top >= box.top && button.bottom <= box.bottom),
          image: getComputedStyle(node).backgroundImage, shadow: getComputedStyle(node).boxShadow };
      });
    return { results, overflow: drawer.scrollWidth - drawer.clientWidth,
      opaque: rgba(getComputedStyle(drawer).backgroundColor)[3], scrimAlpha: scrim[3],
      modal: drawer.matches(":modal"), background: getComputedStyle(drawer).backgroundColor, geometry };
  });
}
