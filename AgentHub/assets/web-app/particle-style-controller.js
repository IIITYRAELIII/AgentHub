(function installParticleStyleController(global) {
  "use strict";

  const propertyPattern = /^--[a-z][a-z0-9-]*$/u;
  const valuePattern = /^[a-z0-9+.%() -]+$/iu;

  function parameterRules(parameters) {
    return (parameters ?? []).map((values, index) => {
      const declarations = Object.entries(values ?? {}).map(([property, value]) => {
        const normalized = String(value ?? "").trim();
        if (!propertyPattern.test(property) || !valuePattern.test(normalized)) {
          throw new Error("Некорректный параметр частицы Agent Hub");
        }
        return `${property}:${normalized}`;
      }).join(";");
      return `[data-agent-hub-particles] > span:nth-of-type(${index + 1}){${declarations}}`;
    }).join("\n");
  }

  function install(documentRef, layer, parameters) {
    const style = documentRef.createElement("style");
    const nonce = documentRef.querySelector("style[nonce],script[nonce]")?.nonce;
    if (nonce) style.nonce = nonce;
    style.dataset.agentHubParticleParameters = "";
    style.textContent = parameterRules(parameters);
    layer.prepend(style);
    return style;
  }

  global.AgentHubParticleStyle = Object.freeze({ install, parameterRules });
})(window);
