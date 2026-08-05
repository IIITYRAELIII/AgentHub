import { createDesktopApplicationRouter } from "../interfaces/desktop/desktop-application-router.mjs";

export function createDesktopRouterComposition({
  handlers,
  commands,
  receiptFile,
}) {
  const {
    handleDesktopControl: dispatchDesktopControl,
    forgetDesktopControl,
  } = createDesktopApplicationRouter({
    handlers,
    commands,
    receiptFile,
    reconcileMutation: async ({ action }) => ({
      resolved: false,
      terminal: true,
      error: `Outcome of interrupted ${action} command is unknown; it was not repeated`,
    }),
  });

  async function reconcileRemoteDesktopControl({ action, params, context }) {
    try {
      return {
        resolved: true,
        result: await dispatchDesktopControl({ action, params, context }),
      };
    } catch (error) {
      return { resolved: false, error: error.message };
    }
  }

  return {
    handleDesktopControl: (request) => dispatchDesktopControl(request),
    forgetDesktopControl,
    reconcileRemoteDesktopControl,
  };
}
