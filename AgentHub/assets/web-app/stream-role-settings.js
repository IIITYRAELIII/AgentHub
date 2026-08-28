(function streamRoleSettingsModule(global) {
  "use strict";

  function architectEnabled(settings) {
    return settings?.architect === true;
  }

  function withArchitect(settings, enabled) {
    return {
      ...(settings && typeof settings === "object" ? settings : {}),
      architect: enabled === true,
    };
  }

  global.AgentHubStreamRoleSettings = Object.freeze({ architectEnabled, withArchitect });
})(window);
