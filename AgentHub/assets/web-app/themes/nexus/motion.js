(() => {
  "use strict";

  const root = document.documentElement;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const desktop = matchMedia("(min-width: 860px)");
  const layers = new Map();
  let frame = 0;

  // Traced in the original 1672 x 941 image coordinates. The same paths define
  // both the narrow edge mask and the glint's route: no image-wide light sweep.
  const contours = {
    nexus: [
      "M272 0 C220 105 231 240 281 323 C316 381 357 414 391 486 C423 553 438 635 500 687 C560 739 643 764 733 768 C912 781 1046 677 1190 679 C1403 674 1506 845 1672 890",
      "M0 572 C65 481 162 397 275 412",
      "M499 640 C673 715 830 663 981 604 C1137 537 1245 551 1365 591 C1485 631 1567 731 1672 788",
      "M1005 0 C1124 31 1396 19 1482 129 C1560 222 1557 346 1530 436 C1509 507 1437 552 1358 589",
    ],
    "nexus-refraction": [
      "M18 580 L290 307 L302 731 L402 654 L462 563 L290 307",
      "M18 580 L202 488 L211 645 L70 598 L64 729",
      "M1672 556 L1465 494 L1463 803 L1321 641 L1321 447 L1448 344 L1449 795",
      "M1093 0 L1177 75 L1240 96 L1291 0",
    ],
    "nexus-field": [
      "M153 0 C174 118 283 224 250 329 C223 417 365 456 448 506 C550 566 574 670 659 701",
      "M0 608 C153 563 252 688 344 717 C570 796 753 732 957 672 C1172 610 1377 604 1473 482 C1588 342 1543 169 1442 115 C1350 64 1265 65 1184 77 C1100 91 1030 58 1000 0",
      "M333 941 C395 812 573 778 754 752 C943 723 1112 661 1247 641 C1443 612 1559 558 1672 481",
    ],
  };

  function createScene(scene) {
    const node = document.createElement("span");
    node.className = "nexus-contour-scene";
    const paths = contours[scene];
    const strokes = paths.map(d => `<path d="${d}"/>`).join("");
    const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1672 941"><g fill="none" stroke="white" stroke-linecap="round" stroke-linejoin="round"><g stroke-width="9" opacity=".16">${strokes}</g><g stroke-width="2.5">${strokes}</g></g></svg>`;
    node.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(mask)}")`;
    paths.forEach((d, index) => {
      const glint = document.createElement("span");
      glint.className = "nexus-edge-glint";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      const length = path.getTotalLength();
      const steps = Math.ceil(length / 12);
      const keyframes = Array.from({ length: steps + 1 }, (_, step) => {
        const progress = step / steps;
        const point = path.getPointAtLength(progress * length);
        return {
          transform: `translate3d(${point.x - 80}px, ${point.y - 80}px, 0)`,
          opacity: Math.min(1, progress / .08, (1 - progress) / .12),
        };
      });
      const duration = 16000 + index * 2700;
      node.append(glint);
      glint.animate(keyframes, {
        duration, iterations: Infinity,
        delay: -((performance.now() + index * 4100) % duration),
      });
    });
    return node;
  }

  function retireAnimations(layer) {
    for (const animation of layer.getAnimations({ subtree: true })) animation.cancel();
  }

  // The route is sampled once per scene; transform/opacity animation runs on
  // the compositor. No per-frame JS, canvas or history observer is needed.
  function update() {
    frame = 0;
    const enabled = root.dataset.theme === "nexus" && !document.hidden
      && window.AgentHubBackgroundMotionPreference.enabled(root, reducedMotion);
    const panelScene = desktop.matches && root.dataset.view === "chat"
      && root.dataset.surface === "desktop";
    const scene = Object.hasOwn(contours, root.dataset.background) ? root.dataset.background : "nexus";
    const scale = Math.max(innerWidth / 1672, innerHeight / 941);
    const targets = enabled
      ? [...document.querySelectorAll(panelScene
        ? ".app-header, .task-rail, .chat, .activity-rail"
        : ".app-header"), ...(panelScene ? [] : [document.body])]
      : [];
    for (const [target, layer] of layers) {
      if (!targets.includes(target)) {
        retireAnimations(layer);
        layer.remove();
        layers.delete(target);
      }
    }
    // Read every box before writing styles, including border inset: the traces
    // must use the same viewport projection as background-attachment: fixed.
    const boxes = targets.map(target => {
      const box = target.getBoundingClientRect();
      return [target, target === document.body ? 0 : box.left + target.clientLeft,
        target === document.body ? 0 : box.top + target.clientTop];
    });
    for (const [target, left, top] of boxes) {
      let layer = layers.get(target);
      if (!layer) {
        layer = document.createElement("span");
        layer.className = "nexus-contour-light";
        layer.setAttribute("aria-hidden", "true");
        target.prepend(layer);
        layers.set(target, layer);
      }
      if (layer.dataset.scene !== scene) {
        retireAnimations(layer);
        layer.replaceChildren(createScene(scene));
        layer.dataset.scene = scene;
      }
      layer.style.setProperty("--nexus-left", `${left}px`);
      layer.style.setProperty("--nexus-top", `${top}px`);
      layer.style.setProperty("--nexus-scene-x", `${(innerWidth - 1672 * scale) / 2 - left}px`);
      layer.style.setProperty("--nexus-scene-y", `${(innerHeight - 941 * scale) / 2 - top}px`);
      layer.style.setProperty("--nexus-scene-scale", scale);
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  const resize = new ResizeObserver(schedule);
  for (const target of [root, ...document.querySelectorAll(".app-header, .task-rail, .chat, .activity-rail")]) {
    resize.observe(target);
  }
  new MutationObserver(schedule).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme", "data-background", "data-background-motion", "data-view", "data-surface", "data-activity-rail-visibility"],
  });
  reducedMotion.addEventListener("change", schedule);
  desktop.addEventListener("change", schedule);
  document.addEventListener("visibilitychange", () => {
    // Hidden documents may suspend requestAnimationFrame before its callback.
    if (document.hidden) {
      cancelAnimationFrame(frame);
      update();
    } else schedule();
  });
  window.addEventListener("resize", schedule);
  update();
})();
