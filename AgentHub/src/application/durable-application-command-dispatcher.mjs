import { commandFingerprint } from "../domain/command-fingerprint.mjs";

function commandBaseId(context = {}) {
  return String(context.commandId ?? "").trim();
}

function updateCommandBaseId(update = {}) {
  if (Number.isSafeInteger(update?.message?.message_id) && Number.isSafeInteger(update?.message?.chat?.id)) {
    return `message:${update.message.chat.id}:${update.message.message_id}`;
  }
  return update?.callback_query?.id ? `callback:${update.callback_query.id}` : "";
}

export class DurableApplicationCommandDispatcher {
  constructor({ receipts, dispatch, reconcile = null } = {}) {
    if (typeof receipts?.execute !== "function" || typeof receipts?.forgetPrefix !== "function") {
      throw new TypeError("durable application command receipts are required");
    }
    if (typeof dispatch !== "function") throw new TypeError("application command dispatch is required");
    this.receipts = receipts;
    this.dispatchCommand = dispatch;
    this.reconcile = typeof reconcile === "function" ? reconcile : null;
  }

  dispatch(type, params, context = {}, options = {}) {
    const baseId = commandBaseId(context);
    if (context?.source !== "telegram" || !baseId) {
      return this.dispatchCommand(type, params, context, options);
    }
    const id = `${baseId}:${String(type ?? "").trim()}`;
    return this.receipts.execute({
      id,
      fingerprint: commandFingerprint({ type, params, context, options }),
      action: String(type ?? ""),
      effect: () => this.dispatchCommand(type, params, context, options),
      reconcile: this.reconcile
        ? (receipt) => this.reconcile({ type, params, context, options, receipt })
        : async () => ({
            resolved: false,
            terminal: true,
            error: `Outcome of interrupted Telegram ${type} command is unknown; it was not repeated`,
          }),
    });
  }

  acknowledgeUpdate(update) {
    const baseId = updateCommandBaseId(update);
    return baseId ? this.receipts.forgetPrefix(`${baseId}:`) : Promise.resolve(0);
  }
}
