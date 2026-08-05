import { routeTelegramCallback } from "./telegram-callback-router.mjs";

export class TelegramCallbackController {
  constructor({ currentContextToken, telegram, dispatch, routeCallback = routeTelegramCallback }) {
    this.currentContextToken = currentContextToken;
    this.telegram = telegram;
    this.dispatch = dispatch;
    this.routeCallback = routeCallback;
  }

  async handle(callback) {
    const route = this.routeCallback(callback.data, this.currentContextToken());
    if (route.kind === "stale") {
      await this.telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Это меню устарело. Откройте его заново.",
        show_alert: true,
      });
      return;
    }
    await this.dispatch({ ...callback, data: route.data }, route);
  }
}
