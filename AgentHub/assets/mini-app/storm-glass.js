"use strict";

/* Гроза темы «Storm».
 *
 * Само стекло рисует общий шейдер `metropolis-glass.js`: капли-линзы,
 * запотевание и прозрачные дорожки там уже сделаны и приняты, а собственная
 * реализация на 2D давала бусины на нитках вместо воды. Этот слой добавляет
 * то, чего в «Мегаполисе» нет, — разряды.
 *
 * Разряд целиком рисуется в буфер один раз за удар, а покадрово только
 * накладывается: покадровое размытие вешало кадр на телефоне. */
(() => {
  const root = document.documentElement;
  const atmosphere = document.querySelector(".theme-atmosphere");
  const canvas = atmosphere?.querySelector("[data-storm-glass]");
  if (!atmosphere || !canvas) return;

  const THEME = "stormglass";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const context = canvas.getContext("2d");
  if (!context) return;

  let frame = 0;
  let width = 0;
  let height = 0;
  let mobile = false;
  let nextLightningAt = 0;
  let lightning = null;

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function resize() {
    mobile = root.dataset.surface === "mobile" || window.innerWidth < 860;
    const ratio = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5);
    width = Math.max(1, Math.round(window.innerWidth));
    height = Math.max(1, Math.round(window.innerHeight));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    lightning = null;
  }

  /* Канал ветвится мелким неровным шагом и сужается книзу: крупные колена и
     постоянная толщина читались нарисованной стрелкой. */
  function createLightning(now) {
    const bolt = document.createElement("canvas");
    const ratio = mobile ? 0.4 : 0.5;
    bolt.width = Math.max(1, Math.round(width * ratio));
    bolt.height = Math.max(1, Math.round(height * ratio));
    const paint = bolt.getContext("2d");
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint.lineCap = "round";
    paint.lineJoin = "round";

    const startX = random(width * 0.12, width * 0.9);
    const endY = random(height * 0.5, height * 0.95);
    const segments = Math.max(10, Math.round(endY / (mobile ? 42 : 26)));
    const points = [{ x: startX, y: -14 }];
    let x = startX;
    for (let index = 1; index <= segments; index += 1) {
      x += random(-13, 13) + Math.sin(index * 1.7) * 4;
      points.push({ x, y: (endY * index) / segments });
    }
    const paths = [points];
    for (let count = 0; count < 2; count += 1) {
      const from = points[Math.round(random(3, points.length - 4))];
      const away = Math.random() < 0.5 ? -1 : 1;
      const branch = [{ ...from }];
      let branchX = from.x;
      for (let index = 1; index <= Math.round(random(3, 6)); index += 1) {
        branchX += away * random(6, 26) + random(-6, 6);
        branch.push({ x: branchX, y: from.y + index * random(16, 30) });
      }
      paths.push(branch);
    }

    // свечение набирается проходами разной ширины, без дорогого размытия
    const passes = mobile
      ? [
        { base: 18, alpha: 0.16, color: "120, 180, 240" },
        { base: 6, alpha: 0.45, color: "206, 232, 255" },
        { base: 2, alpha: 0.95, color: "253, 254, 255" },
      ]
      : [
        { base: 26, alpha: 0.1, color: "108, 168, 236" },
        { base: 13, alpha: 0.2, color: "150, 198, 246" },
        { base: 5.5, alpha: 0.5, color: "206, 232, 255" },
        { base: 2, alpha: 0.95, color: "253, 254, 255" },
      ];
    for (const pass of passes) {
      for (const path of paths) {
        const last = path.length - 1;
        for (let index = 1; index <= last; index += 1) {
          const fade = 1 - (index / last) * 0.4;
          paint.strokeStyle = `rgba(${pass.color}, ${pass.alpha * fade})`;
          paint.lineWidth = Math.max(0.9, pass.base * (1 - (index / last) * 0.45));
          paint.beginPath();
          paint.moveTo(path[index - 1].x, path[index - 1].y);
          paint.lineTo(path[index].x, path[index].y);
          paint.stroke();
        }
      }
    }
    return { startedAt: now, duration: random(420, 640), bolt };
  }

  function intensityAt(now) {
    if (!nextLightningAt) nextLightningAt = now + random(1_200, 3_000);
    if (!lightning && now >= nextLightningAt) lightning = createLightning(now);
    if (!lightning) return 0;
    const elapsed = now - lightning.startedAt;
    if (elapsed >= lightning.duration) {
      lightning = null;
      nextLightningAt = now + random(3_000, 8_000);
      return 0;
    }
    // короткий первый удар и более слабый повтор вместо равномерного мигания
    const first = Math.max(0, 1 - Math.abs(elapsed - 46) / 46);
    const second = Math.max(0, 1 - Math.abs(elapsed - 170) / 74) * 0.62;
    const afterglow = Math.max(0, 1 - elapsed / lightning.duration) * 0.14;
    return Math.min(1, first + second + afterglow);
  }

  function step(now) {
    frame = window.requestAnimationFrame(step);
    const intensity = intensityAt(now);
    context.clearRect(0, 0, width, height);
    if (!intensity || !lightning) return;

    // вспышка освещает всю сцену, и сильнее там, где тучи
    const sky = context.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, `rgba(188, 218, 252, ${0.4 * intensity})`);
    sky.addColorStop(0.55, `rgba(150, 190, 235, ${0.2 * intensity})`);
    sky.addColorStop(1, `rgba(120, 160, 205, ${0.08 * intensity})`);
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    context.globalAlpha = Math.max(
      intensity,
      0.5 * Math.max(0, 1 - (now - lightning.startedAt) / lightning.duration),
    );
    context.drawImage(lightning.bolt, 0, 0, width, height);
    context.globalAlpha = 1;
  }

  function start() {
    if (frame) return;
    frame = window.requestAnimationFrame(step);
  }

  function stop() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    lightning = null;
    nextLightningAt = 0;
    if (width && height) context.clearRect(0, 0, width, height);
  }

  function sync() {
    const active = root.dataset.theme === THEME;
    atmosphere.dataset.stormGlass = active ? "true" : "false";
    if (!active || reducedMotion.matches) {
      stop();
      return;
    }
    resize();
    start();
  }

  window.addEventListener("resize", () => {
    if (root.dataset.theme !== THEME) return;
    resize();
  }, { passive: true });
  reducedMotion.addEventListener?.("change", sync);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else sync();
  });
  sync();
})();
