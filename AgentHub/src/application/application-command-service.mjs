import { ApplicationCommandBus } from "./application-command-bus.mjs";

export function commandClientContext(context, fallbackClientId) {
  const source = String(context?.source ?? "").trim();
  const userId = String(context?.userId ?? "").trim();
  return {
    ...context,
    clientId: String(context?.clientId ?? "").trim()
      || [source || fallbackClientId, userId].filter(Boolean).join(":"),
  };
}

export function commandTaskTarget(params) {
  return {
    streamId: String(params?.streamId ?? "").trim() || null,
    provider: String(params?.provider ?? "").trim() || null,
    projectRoot: String(params?.projectRoot ?? "").trim() || null,
    threadId: String(params?.threadId ?? "").trim() || null,
  };
}

export function createApplicationCommandService({ handlers, selectedTask }) {
  if (!handlers || typeof handlers !== "object") throw new TypeError("command handlers are required");
  if (typeof selectedTask !== "function") throw new TypeError("selectedTask is required");
  const required = [
    "selectTask", "createTask", "rotateStream", "renameTask", "archiveTask",
    "updateSetting", "cancelRun", "resolveApproval",
    "renameWorkspace", "createWorkspaceFromStream", "mergeWorkspaces", "renameStream", "moveStream",
  ];
  for (const name of required) {
    if (typeof handlers[name] !== "function") throw new TypeError(`${name} handler is required`);
  }

  const settingTarget = (params) => {
    const name = String(params?.name ?? "").trim();
    if (!["model", "reasoning", "mode"].includes(name)) return null;
    return commandTaskTarget({ ...selectedTask(), ...params });
  };

  const bus = new ApplicationCommandBus()
    .register("task.select", {
      mutating: true,
      target: "required",
      lane: "global",
      handler: ({ payload, target, context }) => handlers.selectTask({ ...payload, ...target }, context),
    })
    .register("task.create", {
      mutating: true,
      target: "none",
      lane: "global",
      handler: ({ payload, context }) => handlers.createTask(payload, context),
    })
    .register("stream.rotate", {
      mutating: true,
      target: "required",
      lane: "target",
      handler: ({ payload, target }) => handlers.rotateStream({ ...payload, ...target }),
    })
    .register("task.rename", {
      mutating: true,
      target: "required",
      lane: "global",
      handler: ({ payload, target }) => handlers.renameTask({ ...payload, ...target }),
    })
    .register("task.archive", {
      mutating: true,
      target: "required",
      lane: "global",
      handler: ({ payload, target }) => handlers.archiveTask({ ...payload, ...target }),
    })
    .register("settings.update", {
      mutating: true,
      target: "optional",
      lane: "global",
      handler: ({ payload, target }) => handlers.updateSetting({ ...payload, ...target }),
    })
    .register("run.cancel", {
      mutating: true,
      target: "required",
      lane: "target",
      handler: ({ payload, target }) => handlers.cancelRun({ ...payload, ...target }),
    })
    .register("approval.resolve", {
      mutating: true,
      target: "optional",
      lane: "global",
      handler: ({ payload }) => handlers.resolveApproval(payload),
    })
    .register("workspace.rename", {
      mutating: true, target: "none", lane: "global",
      handler: ({ payload }) => handlers.renameWorkspace(payload),
    })
    .register("workspace.create-from-stream", {
      mutating: true, target: "none", lane: "global",
      handler: ({ payload }) => handlers.createWorkspaceFromStream(payload),
    })
    .register("workspace.merge", {
      mutating: true, target: "none", lane: "global",
      handler: ({ payload }) => handlers.mergeWorkspaces(payload),
    })
    .register("stream.rename", {
      mutating: true, target: "none", lane: "global",
      handler: ({ payload }) => handlers.renameStream(payload),
    })
    .register("stream.move", {
      mutating: true, target: "none", lane: "global",
      handler: ({ payload }) => handlers.moveStream(payload),
    });

  const dispatch = (type, params, context, { target = null } = {}) => bus.dispatch({
    type,
    payload: params,
    target,
    context: commandClientContext(context, "agent-hub"),
  });

  return Object.freeze({
    dispatch,
    settingTarget,
    selectTaskFromBinding(binding, context = {}) {
      return dispatch(
        "task.select",
        { taskTitle: binding?.taskTitle },
        context,
        { target: commandTaskTarget(binding) },
      );
    },
  });
}
