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

  function teamLeadEnabled(settings) {
    return settings?.teamLead === true;
  }

  function withTeamLead(settings, enabled) {
    return {
      ...(settings && typeof settings === "object" ? settings : {}),
      teamLead: enabled === true,
    };
  }

  global.AgentHubStreamRoleSettings = Object.freeze({
    architectEnabled,
    teamLeadEnabled,
    withArchitect,
    withTeamLead,
  });
})(window);
