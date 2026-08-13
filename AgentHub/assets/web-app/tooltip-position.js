(function initAgentHubTooltipPosition(global) {
  "use strict";

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function tooltipPosition(fx, fy, {
    minX = 0.08,
    maxX = 0.92,
    minY = 0.14,
    maxY = 0.86,
    flipX = 0.6,
  } = {}) {
    const x = clamp(finite(fx, 0.5), minX, maxX);
    const y = clamp(finite(fy, 0.5), minY, maxY);
    return {
      x,
      y,
      side: x > flipX ? "left" : "right",
    };
  }

  function applyTooltipPosition(element, fx, fy, options) {
    if (!element) return null;
    const position = tooltipPosition(fx, fy, options);
    element.style.left = `${(position.x * 100).toFixed(3).replace(/\.?0+$/u, "")}%`;
    element.style.top = `${(position.y * 100).toFixed(3).replace(/\.?0+$/u, "")}%`;
    element.dataset.side = position.side;
    return position;
  }

  global.AgentHubTooltipPosition = Object.freeze({
    tooltipPosition,
    applyTooltipPosition,
  });
})(window);
