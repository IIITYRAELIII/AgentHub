import { routeTelegramCallback } from "./telegram-callback-router.mjs";

export class TelegramCallbackController {
  constructor({
    currentContextToken,
    telegram,
    dispatch = null,
    handlers = [],
    dispatchApproval = null,
    routeCallback = routeTelegramCallback,
  }) {
    this.currentContextToken = currentContextToken;
    this.telegram = telegram;
    this.dispatch = dispatch;
    this.handlers = handlers;
    this.dispatchApproval = dispatchApproval;
    this.routeCallback = routeCallback;
  }

  async dispatchRoute(callback, route) {
    if (this.dispatch) return this.dispatch(callback, route);
    for (const handler of this.handlers) {
      if (await handler.handle(callback, route)) return true;
    }
    if (route.kind === "approval" && this.dispatchApproval) {
      if (await this.dispatchApproval(callback)) return true;
    }
    await this.telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Эта кнопка устарела",
      show_alert: true,
    });
    return false;
  }

  async handle(callback) {
    const route = this.routeCallback(callback.data, this.currentContextToken(callback.data));
    if (route.kind === "stale") {
      await this.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Это меню устарело. Откройте его заново.",
        show_alert: true,
      });
      return;
    }
    await this.dispatchRoute({ ...callback, data: route.data }, route);
  }
}
