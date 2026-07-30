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
  let nextLightningAt = 0;
  let lightning = null;

  function cssUrl(value) {
    const match = String(value ?? "").trim().match(/^url\((['"]?)(.*)\1\)$/u);
    return match?.[2] ?? "";
  }

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  /* Капля живёт циклами «висит — срывается — замедляется». Каждая величина
     своя, поэтому одинаковых траекторий не возникает. */
  function spawnDrop(initial = false) {
    const heavy = Math.random() < 0.3;
    const size = heavy ? random(6.2, 12.8) : random(2.8, 7.2);
    return {
      x: random(-0.02, 1.02) * width,
      y: initial ? random(-0.1, 1) * height : random(-0.18, -0.02) * height,
      size,
      speed: 0,
      // Штормовые потёки не висят по несколько секунд: тяжёлые сразу срываются,
      // мелкие задерживаются ненадолго и быстро уступают место новым.
      maxSpeed: heavy ? random(280, 560) : random(120, 310),
      rest: heavy ? random(0, 0.18) : random(0, 0.75),
      wobble: random(0, Math.PI * 2),
      wobbleSpeed: random(1.1, 3.6),
      drift: random(-5, 7),
      wind: random(0.055, 0.14),
      trail: heavy ? random(0.9, 1.45) : random(0.6, 1.05),
      heavy,
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

    const target = Math.round((width * height) / 5_200);
    const wanted = reducedMotion.matches ? 0 : Math.max(120, Math.min(360, target));
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

  function createLightning(now) {
    const startX = random(width * 0.18, width * 0.86);
    atmosphere.style.setProperty("--storm-bolt-x", `${(startX / Math.max(width, 1)) * 100}%`);
    atmosphere.style.setProperty("--storm-bolt-tilt", `${random(-8, 8)}deg`);
    const endY = random(height * 0.42, height * 0.82);
    const segments = Math.max(8, Math.round(endY / 42));
    const points = [{ x: startX, y: -12 }];
    let x = startX;
    for (let index = 1; index <= segments; index += 1) {
      const y = (endY * index) / segments;
      x += random(-34, 34) + Math.sin(index * 1.7) * 9;
      points.push({ x, y });
    }
    const branchIndex = Math.max(2, Math.min(points.length - 3, Math.round(random(2, points.length - 3))));
    const branchStart = points[branchIndex];
    const branch = [{ ...branchStart }];
    let branchX = branchStart.x;
    const branchSegments = Math.max(3, Math.round(random(3, 6)));
    for (let index = 1; index <= branchSegments; index += 1) {
      branchX += random(-42, 16);
      branch.push({
        x: branchX,
        y: branchStart.y + index * random(22, 38),
      });
    }
    return {
      startedAt: now,
      duration: random(430, 620),
      points,
      branch,
    };
  }

  function lightningIntensity(now) {
    if (!nextLightningAt) nextLightningAt = now + random(900, 2_400);
    if (!lightning && now >= nextLightningAt) lightning = createLightning(now);
    if (!lightning) return 0;
    const elapsed = now - lightning.startedAt;
    if (elapsed >= lightning.duration) {
      lightning = null;
      nextLightningAt = now + random(3_000, 8_000);
      return 0;
    }
    // Короткий первый удар и более слабый повтор читаются естественнее
    // равномерного CSS-мигания.
    const first = Math.max(0, 1 - Math.abs(elapsed - 54) / 54);
    const second = Math.max(0, 1 - Math.abs(elapsed - 188) / 78) * 0.68;
    const afterglow = Math.max(0, 1 - elapsed / lightning.duration) * 0.12;
    return Math.min(1, first + second + afterglow);
  }

  function traceLightning(points) {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }
    context.stroke();
  }

  function drawLightning(now) {
    const intensity = lightningIntensity(now);
    const striking = Boolean(intensity && lightning);
    if (atmosphere.dataset.stormStrike !== String(striking)) {
      atmosphere.dataset.stormStrike = String(striking);
    }
    if (!striking) return;
    context.save();
    context.globalCompositeOperation = "screen";
    context.fillStyle = `rgba(185, 218, 255, ${0.22 * intensity})`;
    context.fillRect(0, 0, width, height);

    const boltLife = Math.max(
      intensity,
      0.5 * Math.max(0, 1 - (now - lightning.startedAt) / lightning.duration),
    );
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = `rgba(164, 215, 255, ${0.98 * boltLife})`;
    context.shadowBlur = 32;
    context.strokeStyle = `rgba(190, 225, 255, ${0.9 * boltLife})`;
    context.lineWidth = 8;
    traceLightning(lightning.points);
    traceLightning(lightning.branch);

    context.shadowBlur = 10;
    context.strokeStyle = `rgba(252, 254, 255, ${Math.min(1, 1.18 * boltLife)})`;
    context.lineWidth = 2.2;
    traceLightning(lightning.points);
    traceLightning(lightning.branch);
    context.restore();
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
      drop.speed = Math.min(drop.maxSpeed, drop.speed + drop.maxSpeed * 5.6 * delta);
      drop.y += drop.speed * delta;
      drop.x += (
        drop.wind * drop.speed
        + Math.sin(drop.life * drop.wobbleSpeed + drop.wobble) * drop.drift
      ) * delta;

      /* След уже головы и сходит на нет: сплошная полоса во всю толщину
         капли читалась как прочерченная палка, а не как влажная дорожка. */
      context.lineWidth = Math.max(0.6, drop.size * 0.42 * drop.trail);
      context.beginPath();
      context.moveTo(drop.x, previousY);
      context.lineTo(drop.x, drop.y);
      context.stroke();
      drawDropHead(context, drop);

      // случайная остановка: капля цепляется за неровность и снова копит массу
      if (!drop.heavy && Math.random() < 0.24 * delta) {
        drop.speed = 0;
        drop.rest = random(0.08, 0.48);
      }
      if (drop.y - drop.size * 2 > height || drop.x - drop.size > width) {
        Object.assign(drop, spawnDrop());
      }
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
    drawLightning(now);
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
    lightning = null;
    nextLightningAt = 0;
    atmosphere.dataset.stormStrike = "false";
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
  image.addEventListener("error", () => {
    atmosphere.dataset.ready = "false";
    console.warn("Agent Hub: Storm texture is unavailable");
  }, { once: true });
  image.src = cssUrl(
    window.getComputedStyle(root).getPropertyValue("--stormglass-image"),
  );

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
