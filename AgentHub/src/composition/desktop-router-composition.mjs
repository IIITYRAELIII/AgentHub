import { commandClientContext } from "../application/application-command-service.mjs";
import { createDesktopApplicationRouter } from "../interfaces/desktop/desktop-application-router.mjs";

export function createDesktopRouterComposition({
  handlers,
  commands,
  receiptFile,
  receiptOptions = {},
  commandTrace = null,
  canonicalizeRequest = (request) => request,
}) {
  const {
    handleDesktopControl: dispatchDesktopControl,
    forgetDesktopControl,
  } = createDesktopApplicationRouter({
    handlers,
    commands,
    receiptFile,
    receiptOptions,
    reconcileMutation: async ({ action, params, context }) => {
      return { resolved: false, terminal: true,
        error: `Outcome of interrupted ${action} command is unknown; it was not repeated` };
    },
    commandTrace,
  });

  async function reconcileRemoteDesktopControl({ action, params, context }) {
    try {
      return {
        resolved: true,
        result: await dispatchDesktopControl(canonicalizeRequest({ action, params, context })),
      };
    } catch (error) {
      return { resolved: false, error: error.message };
    }
  }

  return {
    handleDesktopControl: (request) => dispatchDesktopControl(canonicalizeRequest(request)),
    forgetDesktopControl,
    reconcileRemoteDesktopControl,
  };
}
