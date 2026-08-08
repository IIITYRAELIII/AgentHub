/* Свет по чату при завершении свёртки и ротации контекста.

   Отдельный модуль, а не врезка в общий клиент: событие уже описано текстом
   служебной реплики, и наблюдения за лентой достаточно, чтобы не трогать
   логику обслуживания контекста. */

const FLASHES = [
  { prefix: "Ротация завершена успешно", kind: "rotation" },
  { prefix: "Свёртка завершена успешно", kind: "compaction" },
];

function flashKind(node) {
  if (!(node instanceof HTMLElement)) return "";
  if (!node.classList?.contains("msg-maintenance")) return "";
  const text = (node.textContent ?? "").trim();
  return FLASHES.find((flash) => text.startsWith(flash.prefix))?.kind ?? "";
}

function play(pane, kind) {
  if (!pane) return;
  /* Повторный запуск на том же элементе не перезапускает анимацию, поэтому
     сначала снимаем признак и даём браузеру перерисовать кадр. */
  delete pane.dataset.contextFlash;
  void pane.offsetWidth;
  pane.dataset.contextFlash = kind;
  const stop = () => delete pane.dataset.contextFlash;
  pane.addEventListener("animationend", stop, { once: true });
  window.setTimeout(stop, 2600);
}

function start() {
  const log = document.querySelector("[data-chat-log]");
  const pane = document.querySelector(".chat");
  if (!log || !pane) return;
  let ready = false;
  /* Первая отрисовка ленты приносит всю историю сразу: подсвечивать её целиком
     не нужно, эффект относится только к событию, случившемуся при нас. */
  window.setTimeout(() => { ready = true; }, 1500);
  new MutationObserver((records) => {
    if (!ready) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        const kind = flashKind(node) || flashKind(node.querySelector?.(".msg-maintenance"));
        if (kind) {
          play(pane, kind);
          return;
        }
      }
    }
  }).observe(log, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
