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
      if (action === "complete-workspace-release") {
        try {
          const result = await commands.dispatch("workspace.release.complete", { ...params, reconcileOnly: true },
            commandClientContext(context, "desktop"));
          return { resolved: true, result };
        } catch (error) {
          // Only the exact finalization owner may reconcile this action. Missing
          // evidence never authorizes a fresh closure, and remains unresolved.
          return { resolved: false, terminal: false, error: error.message };
        }
      }
      if (action === "release-operation-run") {
        try {
          return { resolved: true, result: await handlers.releaseOperationRun(params) };
        } catch (error) {
          return { resolved: false, terminal: false, error: error.message };
        }
      }
      if (action === "release-operation-continue") {
        try {
          return { resolved: true, result: await handlers.releaseOperationContinue(params) };
        } catch (error) {
          return { resolved: false, terminal: false, error: error.message };
        }
      }
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
