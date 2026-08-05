import { BackgroundJobQueue } from "../runtime/background-job-queue.mjs";
import { PersistentBackgroundJobController } from "../runtime/background-job-controller.mjs";
import { PersistentBackgroundJobStore } from "../infrastructure/persistence/background-job-store.mjs";
import { FailedTelegramUpdateStore } from "../infrastructure/persistence/failed-update-store.mjs";

export async function createBackgroundWorkComposition({
  backgroundDirectory,
  failedUpdatesDirectory,
  maxMediaJobs,
  maxSpeechJobs,
  maxInteractiveJobs,
  isStopping,
  onIdle,
  sendMessage,
  media,
  forwardBundles,
}) {
  const failedUpdateStore = new FailedTelegramUpdateStore({
    directoryPath: failedUpdatesDirectory,
  });
  await failedUpdateStore.load();

  const backgroundJobStore = new PersistentBackgroundJobStore({
    directoryPath: backgroundDirectory,
    maxItems: maxMediaJobs + maxSpeechJobs,
  });
  const backgroundJobs = new PersistentBackgroundJobController({
    store: backgroundJobStore,
    maxMediaJobs,
    maxSpeechJobs,
    isStopping,
    onIdle,
    sendMessage,
    media,
    forwardBundles,
  });
  const interactiveJobs = new BackgroundJobQueue({
    concurrency: 2,
    maxJobs: maxInteractiveJobs,
  });

  return {
    failedUpdateStore,
    backgroundJobStore,
    backgroundJobs,
    interactiveJobs,
  };
}
