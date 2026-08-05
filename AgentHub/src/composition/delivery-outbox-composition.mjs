import { PersistentDeliveryOutbox } from "../infrastructure/persistence/delivery-outbox.mjs";

export async function createDeliveryOutboxComposition({
  directoryPath,
  retryIntervalMs,
  runtimeTimers,
  isStopping,
  deliver,
  onDelivered,
  onPermanentFailure,
  logger = console,
}) {
  const deliveryOutbox = new PersistentDeliveryOutbox({
    directoryPath,
    deliver,
    onDelivered,
    onPermanentFailure,
  });
  await deliveryOutbox.load();

  function scheduleFlush(delayMs = retryIntervalMs) {
    if (isStopping()) return;
    const delayValue = Math.max(0, Number(delayMs) || 0);
    runtimeTimers.schedule("delivery-outbox", () => {
      void flush();
    }, delayValue, { replaceIfEarlier: true });
  }

  async function flush() {
    try {
      const result = await deliveryOutbox.flush();
      if (result.delivered) {
        logger.log(
          `Delivered ${result.delivered} queued Telegram message(s); remaining: ${result.remaining}.`,
        );
      }
    } catch (error) {
      logger.error("Cannot flush Telegram delivery outbox:", error.message);
    } finally {
      scheduleFlush();
    }
  }

  return {
    deliveryOutbox,
    scheduleDeliveryOutboxFlush: scheduleFlush,
    flushDeliveryOutbox: flush,
  };
}
