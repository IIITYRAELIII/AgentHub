(() => {
  "use strict";

  const root = document.documentElement;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const desktop = matchMedia("(min-width: 860px)");
  const layers = new Map();
  let frame = 0;

  // Layout observations only. The light itself moves on the compositor;
  // no animation loop, canvas, image decoding or history observers are needed.
  function update() {
    frame = 0;
    const enabled = root.dataset.theme === "nexus" && !document.hidden
      && window.AgentHubBackgroundMotionPreference.enabled(root, reducedMotion);
    const panelScene = desktop.matches && root.dataset.view === "chat"
      && root.dataset.surface === "desktop";
    const targets = enabled
      ? [...document.querySelectorAll(panelScene
        ? ".app-header, .task-rail, .chat, .activity-rail"
        : ".app-header"), ...(panelScene ? [] : [document.body])]
      : [];
    for (const [target, layer] of layers) {
      if (!targets.includes(target)) {
        layer.remove();
        layers.delete(target);
      }
    }
    // Read every box before writing styles, including border inset: the mask
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
        layer.append(document.createElement("span"));
        // All newly mounted panes join the same phase, including after resize
        // or navigation. Existing panes keep their running CSS animation.
        layer.style.setProperty("--nexus-phase", `${-(performance.now() % 12000)}ms`);
        target.prepend(layer);
        layers.set(target, layer);
      }
      layer.style.setProperty("--nexus-left", `${left}px`);
      layer.style.setProperty("--nexus-top", `${top}px`);
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
