"use strict";

/* Запотевшее стекло темы «Storm».
 *
 * Отличия от стекла «Мегаполиса» — по замечаниям с обсуждения:
 *   • капли не круглые: голова вытянута и сужается кверху, за ней остаётся
 *     влажная дорожка переменной ширины;
 *   • движение несинхронное: капля висит, копит массу и срывается в свой
 *     момент, а не едет вместе со всеми по общей сетке;
 *   • стекло не «отмывается» насовсем: протёртое медленно затягивается
 *     обратно, поэтому дорожки живут своей жизнью и исчезают.
 *
 * Физика запотевания честная: слой рисует размытую копию того же фонового
 * снимка, а капли стирают её (destination-out), открывая резкий фон под
 * canvas. Размытая копия готовится один раз на изменение размера, поэтому
 * покадрово выполняются только дешёвые операции. */
(() => {
  const root = document.documentElement;
  const atmosphere = document.querySelector(".theme-atmosphere");
  const canvas = atmosphere?.querySelector("[data-storm-glass]");
  if (!atmosphere || !canvas) return;

  const THEME = "stormglass";
  const IMAGE = "/storm-sea.png";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const context = canvas.getContext("2d");
  if (!context) return;

  const fog = document.createElement("canvas");
  const fogContext = fog.getContext("2d");
  const image = new Image();
  let imageReady = false;
  let frame = 0;
  let lastTime = 0;
  let width = 0;
  let height = 0;
  let scale = 1;
  const drops = [];

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  /* Капля живёт циклами «висит — срывается — замедляется». Каждая величина
     своя, поэтому одинаковых траекторий не возникает. */
  function spawnDrop(initial = false) {
    const size = random(1.8, 5.4);
    return {
      x: random(-0.02, 1.02) * width,
      y: initial ? random(-0.1, 1) * height : random(-0.18, -0.02) * height,
      size,
      speed: 0,
      // крупные капли тяжелее: срываются быстрее и едут дальше
      maxSpeed: size * random(7, 16),
      rest: random(0.1, 2.6),
      wobble: random(0, Math.PI * 2),
      wobbleSpeed: random(0.6, 2.1),
      drift: random(-0.35, 0.35),
      trail: random(0.55, 1),
      life: 0,
    };
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(window.innerWidth));
    height = Math.max(1, Math.round(window.innerHeight));
    scale = ratio;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    fog.width = canvas.width;
    fog.height = canvas.height;
    fogContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    paintFog();

    const target = Math.round((width * height) / 15000);
    const wanted = Math.max(18, Math.min(reducedMotion.matches ? 0 : 90, target));
    while (drops.length > wanted) drops.pop();
    while (drops.length < wanted) drops.push(spawnDrop(true));
    if (imageReady) context.drawImage(fog, 0, 0, width, height);
  }

  /* Размытая копия фона плюс холодная молочная плёнка: вместе это и есть
     «запотевание». Готовится один раз на размер окна. */
  function paintFog() {
    if (!imageReady || !width || !height) return;
    const cover = Math.max(width / image.width, height / image.height);
    const drawWidth = image.width * cover;
    const drawHeight = image.height * cover;
    // кадр смещён к правому краю: там маяк, и его свет собирают капли
    const offsetX = (width - drawWidth) * 0.62;
    const offsetY = (height - drawHeight) * 0.5;
    fogContext.setTransform(scale, 0, 0, scale, 0, 0);
    fogContext.clearRect(0, 0, width, height);
    fogContext.filter = "blur(6px) saturate(0.9) brightness(0.96)";
    fogContext.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
    fogContext.filter = "none";
    fogContext.fillStyle = "rgba(206, 224, 238, 0.1)";
    fogContext.fillRect(0, 0, width, height);
  }

  function drawDropHead(target, drop) {
    const rx = drop.size * 0.72;
    const ry = drop.size;
    target.beginPath();
    // голова — вытянутый эллипс, сверху сходится в носик: круглая капля
    // выглядела как пузырь, а не как вода на стекле
    target.moveTo(drop.x, drop.y - ry * 1.9);
    target.bezierCurveTo(
      drop.x + rx * 0.9, drop.y - ry * 0.7,
      drop.x + rx, drop.y + ry * 0.35,
      drop.x, drop.y + ry,
    );
    target.bezierCurveTo(
      drop.x - rx, drop.y + ry * 0.35,
      drop.x - rx * 0.9, drop.y - ry * 0.7,
      drop.x, drop.y - ry * 1.9,
    );
    target.closePath();
    target.fill();
  }

  function step(now) {
    frame = window.requestAnimationFrame(step);
    if (!imageReady) return;
    const delta = Math.min(0.05, lastTime ? (now - lastTime) / 1000 : 0.016);
    lastTime = now;

    // стекло затягивается обратно: без этого дорожки накапливались бы, и через
    // минуту от запотевания не осталось бы следа
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = Math.min(0.5, 0.2 * delta * 60);
    context.drawImage(fog, 0, 0, width, height);
    context.globalAlpha = 1;

    context.globalCompositeOperation = "destination-out";
    context.fillStyle = "#000";
    context.strokeStyle = "#000";
    context.lineCap = "round";

    for (const drop of drops) {
      drop.life += delta;
      if (drop.rest > 0) {
        drop.rest -= delta;
        // висящая капля чуть подрагивает — этого хватает, чтобы поток не читался ровным
        drop.x += Math.sin(drop.life * drop.wobbleSpeed + drop.wobble) * 0.12;
        drawDropHead(context, drop);
        continue;
      }

      const previousY = drop.y;
      drop.speed = Math.min(drop.maxSpeed, drop.speed + drop.maxSpeed * 2.4 * delta);
      drop.y += drop.speed * delta;
      drop.x += Math.sin(drop.life * drop.wobbleSpeed + drop.wobble) * drop.drift;

      /* След уже головы и сходит на нет: сплошная полоса во всю толщину
         капли читалась как прочерченная палка, а не как влажная дорожка. */
      context.lineWidth = Math.max(0.6, drop.size * 0.42 * drop.trail);
      context.beginPath();
      context.moveTo(drop.x, previousY);
      context.lineTo(drop.x, drop.y);
      context.stroke();
      drawDropHead(context, drop);

      // случайная остановка: капля цепляется за неровность и снова копит массу
      if (Math.random() < 1.1 * delta) {
        drop.speed = 0;
        drop.rest = random(0.15, 1.4);
      }
      if (drop.y - drop.size * 2 > height) Object.assign(drop, spawnDrop());
    }

    // блики по голове: капля работает как линза и ловит свет маяка
    context.globalCompositeOperation = "source-over";
    for (const drop of drops) {
      const gradient = context.createRadialGradient(
        drop.x - drop.size * 0.3,
        drop.y - drop.size * 0.35,
        drop.size * 0.1,
        drop.x,
        drop.y,
        drop.size * 1.15,
      );
      gradient.addColorStop(0, "rgba(226, 242, 252, 0.5)");
      gradient.addColorStop(0.45, "rgba(190, 216, 234, 0.14)");
      gradient.addColorStop(1, "rgba(190, 216, 234, 0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.ellipse(drop.x, drop.y, drop.size * 0.85, drop.size * 1.1, 0, 0, Math.PI * 2);
      context.fill();
    }
  }

  function start() {
    if (frame) return;
    lastTime = 0;
    frame = window.requestAnimationFrame(step);
  }

  function stop() {
    if (!frame) return;
    window.cancelAnimationFrame(frame);
    frame = 0;
  }

  function sync() {
    const active = root.dataset.theme === THEME;
    atmosphere.dataset.stormGlass = active ? "true" : "false";
    if (!active) {
      // флаг готовности общий с «Мегаполисом», поэтому чужую тему не трогаем
      stop();
      return;
    }
    if (!imageReady) return;
    resize();
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.drawImage(fog, 0, 0, width, height);
    atmosphere.dataset.ready = "true";
    if (reducedMotion.matches) {
      stop();
      return;
    }
    start();
  }

  image.addEventListener("load", () => {
    imageReady = true;
    sync();
  });
  image.src = IMAGE;

  window.addEventListener("resize", () => {
    if (root.dataset.theme !== THEME) return;
    resize();
  });
  reducedMotion.addEventListener?.("change", sync);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (root.dataset.theme === THEME && !reducedMotion.matches) start();
  });
  sync();
})();
