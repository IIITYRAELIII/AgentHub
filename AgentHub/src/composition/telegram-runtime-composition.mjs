import { createTelegramControllerComposition } from "./telegram-controller-composition.mjs";
import { createTelegramShellWiring } from "./telegram-shell-wiring-composition.mjs";

export function createTelegramRuntimeComposition({
  shell,
  controller,
  ports,
  createShell = createTelegramShellWiring,
  createController = createTelegramControllerComposition,
}) {
  ports.telegramShell.bind(createShell(shell));

  const sendStatus = (snapshot = controller.currentStatusSnapshot()) => (
    ports.telegramShell.api.sendStatus(snapshot)
  );
  const telegramController = createController({
    ...controller,
    sendStatus,
  });

  return {
    ...telegramController,
    sendStatus,
  };
}
