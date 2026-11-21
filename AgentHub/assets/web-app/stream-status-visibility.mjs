/* Пауза анимаций Stream за пределами окна.

   При двух десятках идущих потоков браузер держит столько же бесконечных
   анимаций, включая невидимые. Наблюдатель помечает карточки вне окна, а
   таблица стилей ставит их анимации на паузу. */

const CARD_SELECTOR = ".task-workspace-item, .stream-tab";

// Trace the border box clockwise, starting at the top-left tangent.
function contourPath(width, height, corners, cut, inset) {
  const x = width - inset;
  const y = height - inset;
  if (x <= inset || y <= inset) return "";
  const radii = corners.map(radius => {
    if (cut) {
      const bevel = Math.max(0, cut - (2 - Math.SQRT2) * inset);
      return [bevel, bevel];
    }
    return [
      Math.min((x - inset) / 2, Math.max(0, radius - inset)),
      Math.min((y - inset) / 2, Math.max(0, radius - inset)),
    ];
  });
  const [tl, tr, br, bl] = radii;
  const corner = ([rx, ry], endX, endY) =>
    cut || !rx || !ry ? `L ${endX} ${endY}` : `A ${rx} ${ry} 0 0 1 ${endX} ${endY}`;
  return [
    `M ${inset + tl[0]} ${inset} H ${x - tr[0]}`, corner(tr, x, inset + tr[1]),
    `V ${y - br[1]}`, corner(br, x - br[0], y),
    `H ${inset + bl[0]}`, corner(bl, inset, y - bl[1]),
    `V ${inset + tl[1]}`, corner(tl, inset + tl[0], inset), "Z",
  ].join(" ");
}

function fitContour(card) {
  const layer = card.querySelector(":scope > .stream-effect-layer");
  if (!layer) return;
  const outline = layer.querySelector(".stream-frame-outline");
  const width = Number.parseFloat(getComputedStyle(layer).width);
  const height = Number.parseFloat(getComputedStyle(layer).height);
  if (!outline || !width || !height) return;
  const style = getComputedStyle(card);
  const cut = Number.parseFloat(style.getPropertyValue("--stream-frame-cut")) || 0;
  const corners = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"]
    .map(corner => Number.parseFloat(style[`border${corner}Radius`]));
  const left = Number.parseFloat(style.borderLeftWidth);
  const top = Number.parseFloat(style.borderTopWidth);
  const outerWidth = width + left + Number.parseFloat(style.borderRightWidth);
  const outerHeight = height + top + Number.parseFloat(style.borderBottomWidth);
  // Absolute children start at the padding edge, including on thick image borders.
  const transform = `translate(${-left} ${-top})`;
  for (const [path, inset] of [[outline, card.hasAttribute("data-interstream-run") ? 1.75 : 1],
    [layer.querySelector(".stream-maintenance-track"), 4.5]]) {
    const d = contourPath(outerWidth, outerHeight, corners, cut, inset);
    if (path.getAttribute("transform") !== transform) path.setAttribute("transform", transform);
    if (path.getAttribute("d") !== d) path.setAttribute("d", d);
  }
}

function forCards(root, visit) {
  if (root.matches?.(CARD_SELECTOR)) visit(root);
  for (const card of root.querySelectorAll(CARD_SELECTOR)) visit(card);
}

function start() {
  const size = new ResizeObserver(entries => {
    for (const { target } of entries) fitContour(target);
  });
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) delete entry.target.dataset.streamOffscreen;
      else entry.target.dataset.streamOffscreen = "";
    }
  }, { rootMargin: "120px" });
  const observe = card => {
    size.observe(card, { box: "border-box" });
    visibility.observe(card);
  };
  const forget = card => {
    size.unobserve(card);
    visibility.unobserve(card);
  };
  forCards(document, observe);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") {
        fitContour(record.target);
        continue;
      }
      for (const node of record.removedNodes) {
        if (node instanceof HTMLElement && !node.isConnected) forCards(node, forget);
      }
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.isConnected) forCards(node, observe);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-interstream-run"] });
  // A theme switch can change just the corners without resizing the card.
  new MutationObserver(() => forCards(document, fitContour)).observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-theme", "data-view", "data-surface"],
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
