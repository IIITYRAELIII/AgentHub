/* Пауза анимаций Stream за пределами окна.

   При двух десятках идущих потоков браузер держит столько же бесконечных
   анимаций, включая невидимые. Наблюдатель помечает карточки вне окна, а
   таблица стилей ставит их анимации на паузу. */

const CARD_SELECTOR = ".task-workspace-item, .stream-tab";

function observeCards(observer, root) {
  for (const card of root.querySelectorAll(CARD_SELECTOR)) observer.observe(card);
}

function start() {
  if (typeof IntersectionObserver !== "function") return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) delete entry.target.dataset.streamOffscreen;
      else entry.target.dataset.streamOffscreen = "";
    }
  }, { rootMargin: "120px" });

  observeCards(observer, document);
  /* Списки перерисовываются целиком, поэтому новые карточки подхватываем
     наблюдателем за деревом, а не повторным обходом по таймеру. */
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(CARD_SELECTOR)) observer.observe(node);
        observeCards(observer, node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
