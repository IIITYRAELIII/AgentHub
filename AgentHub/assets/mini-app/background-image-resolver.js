(function installBackgroundImageResolver(global) {
  "use strict";

  function resolve(backgroundImage, assetImage) {
    const source = String(backgroundImage ?? "").trim();
    const replacement = String(assetImage ?? "").trim();
    if (!source || !replacement) return source;
    const start = source.lastIndexOf("url(");
    if (start < 0) return source;
    const end = source.indexOf(")", start);
    if (end < 0) return source;
    return `${source.slice(0, start)}${replacement}${source.slice(end + 1)}`;
  }

  global.AgentHubBackgroundImageResolver = Object.freeze({ resolve });
})(window);
