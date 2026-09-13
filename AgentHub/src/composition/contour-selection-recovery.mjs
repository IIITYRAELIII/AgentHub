import { CONTOUR_TARGET_PROJECT_MISMATCH } from "../infrastructure/filesystem/test-contour-command-mapping.mjs";

/* Глобальный выбор recording-контура мог сохраниться с содержащим проектом,
   тогда как canonical Thread binding называет вложенный каталог. Guard
   владельца mapping отказывает такому выбору в праве на выполнение, и раньше
   этот отказ ронял весь запуск в конструкторе выбора Telegram.

   Здесь обрабатывается только это конкретное расхождение: сбрасывается
   выбранный Thread активного провайдера, проект остаётся. Binding, история,
   очереди и выбор отдельных клиентов не меняются; Thread выбирается заново
   обычным путём через binding. Любая другая ошибка запуска остаётся видимой. */
export function recoverRejectedContourSelection({
  mapping,
  selectionStore,
  selectedTask,
  logger = console,
}) {
  if (!mapping) return null;
  try {
    mapping.target(selectedTask());
    return null;
  } catch (error) {
    if (error?.code !== CONTOUR_TARGET_PROJECT_MISMATCH) throw error;
    const rejected = {
      provider: selectionStore.activeProvider,
      streamId: selectionStore.streamId,
      threadId: selectionStore.threadId,
      projectRoot: selectionStore.activeProjectRoot,
    };
    selectionStore.setThread(null, {
      provider: selectionStore.activeProvider,
      streamId: null,
      title: "",
    });
    logger.warn?.(
      `Stored contour selection was rejected by the canonical Thread binding; `
        + `cleared selected ${rejected.provider} Thread ${rejected.threadId} `
        + `(Stream ${rejected.streamId}, project ${rejected.projectRoot}): ${error.message}`,
    );
    return rejected;
  }
}
