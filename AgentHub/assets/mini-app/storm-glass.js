"use strict";

/* Запотевшее стекло темы «Storm».
 *
 * Отличия от стекла «Мегаполиса» — по замечаниям с обсуждения:
 *   • капли не круглые: голова вытянута, сужается кверху и растягивается тем
 *     сильнее, чем быстрее падает, за ней остаётся влажная дорожка;
 *   • движение несинхронное: капля висит, копит массу и срывается в свой
 *     момент, а не едет вместе со всеми по общей сетке;
 *   • стекло не «отмывается» насовсем: протёртое затягивается обратно,
 *     поэтому дорожки живут секунду и исчезают.
 *
 * Физика запотевания честная: слой рисует размытую копию того же фонового
 * снимка, а капли стирают её (destination-out), открывая резкий фон под
 * canvas. Размытая копия готовится один раз на изменение размера, поэтому
 * покадрово выполняются только дешёвые операции.
 *
 * Гроза живёт на этом же холсте: разряд подсвечивает всю сцену и виден сквозь
 * мутное стекло, поэтому канал размыт и сужается книзу. */
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
  /* Бисер, оставленный прошедшей каплей: без него дорожка читается голой
     полосой, а на настоящем стекле за каплей всегда тянется мелочь. */
  const beads = [];
  const BEAD_LIMIT = 320;
  const lenses = new Map();
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
     своя, поэтому одинаковых траекторий не возникает. Тяжёлых меньше, но
     именно они делают шторм штормом. */
  function spawnDrop(initial = false) {
    const heavy = Math.random() < 0.3;
    const size = heavy ? random(8, 16.5) : random(3, 7);
    return {
      x: random(-0.02, 1.02) * width,
      y: initial ? random(-0.1, 1) * height : random(-0.2, -0.02) * height,
      size,
      speed: 0,
      maxSpeed: heavy ? random(300, 620) : random(130, 320),
      rest: heavy ? random(0, 0.2) : random(0, 0.9),
      wobble: random(0, Math.PI * 2),
      wobbleSpeed: random(1.1, 3.6),
      drift: random(-4, 5),
      wind: random(0.04, 0.09),
      trail: heavy ? random(0.85, 1.25) : random(0.55, 0.95),
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
    beads.length = 0;
    lenses.clear();
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

  function drawDropHead(target, drop, stretch = 1) {
    const rx = drop.size * 0.72;
    const ry = drop.size * stretch;
    target.beginPath();
    /* Голова — вытянутый эллипс, сверху сходится в носик. Носик короткий:
       длинный превращал каплю в стрелку из чистого стекла над головой. */
    target.moveTo(drop.x, drop.y - ry * 1.15);
    target.bezierCurveTo(
      drop.x + rx * 0.9, drop.y - ry * 0.6,
      drop.x + rx, drop.y + ry * 0.35,
      drop.x, drop.y + ry,
    );
    target.bezierCurveTo(
      drop.x - rx, drop.y + ry * 0.35,
      drop.x - rx * 0.9, drop.y - ry * 0.6,
      drop.x, drop.y - ry * 1.15,
    );
    target.closePath();
    target.fill();
  }

  /* Объём капли — готовый спрайт: создавать градиент на каждую каплю в кадре
     дорого, а размеров всего десятка полтора. */
  function lens(size) {
    const key = Math.max(2, Math.round(size));
    const cached = lenses.get(key);
    if (cached) return cached;
    const box = Math.ceil(key * 4);
    const sprite = document.createElement("canvas");
    sprite.width = box;
    sprite.height = box;
    const paint = sprite.getContext("2d");
    const middle = box / 2;
    // тёмная кромка снизу-справа: без неё стёртая голова читается кляксой
    const rim = paint.createRadialGradient(
      middle + key * 0.35, middle + key * 0.45, key * 0.15,
      middle, middle, key * 1.5,
    );
    rim.addColorStop(0, "rgba(8, 16, 26, 0)");
    rim.addColorStop(0.72, "rgba(8, 16, 26, 0.28)");
    rim.addColorStop(1, "rgba(8, 16, 26, 0)");
    paint.fillStyle = rim;
    paint.beginPath();
    paint.ellipse(middle, middle, key * 1.05, key * 1.35, 0, 0, Math.PI * 2);
    paint.fill();
    // блик: капля работает как линза и собирает свет маяка
    const glare = paint.createRadialGradient(
      middle - key * 0.34, middle - key * 0.42, key * 0.08,
      middle, middle, key * 1.25,
    );
    glare.addColorStop(0, "rgba(233, 246, 255, 0.7)");
    glare.addColorStop(0.4, "rgba(196, 222, 240, 0.18)");
    glare.addColorStop(1, "rgba(196, 222, 240, 0)");
    paint.fillStyle = glare;
    paint.beginPath();
    paint.ellipse(middle, middle, key * 0.92, key * 1.2, 0, 0, Math.PI * 2);
    paint.fill();
    lenses.set(key, sprite);
    return sprite;
  }

  function addBead(drop) {
    if (beads.length >= BEAD_LIMIT) beads.shift();
    beads.push({
      x: drop.x + random(-drop.size, drop.size) * 0.5,
      y: drop.y - random(0, drop.size * 2),
      size: Math.max(0.5, drop.size * random(0.12, 0.34)),
      life: random(0.6, 2.2),
    });
  }

  function createLightning(now) {
    const startX = random(width * 0.12, width * 0.9);
    const endY = random(height * 0.5, height * 0.95);
    const segments = Math.max(12, Math.round(endY / 26));
    const points = [{ x: startX, y: -14 }];
    let x = startX;
    for (let index = 1; index <= segments; index += 1) {
      // мелкий неровный шаг: крупные колена читались нарисованной стрелкой
      x += random(-13, 13) + Math.sin(index * 1.7) * 4;
      points.push({ x, y: (endY * index) / segments });
    }
    const branches = [];
    for (let count = 0; count < 2; count += 1) {
      const from = points[Math.round(random(3, points.length - 4))];
      const away = Math.random() < 0.5 ? -1 : 1;
      const branch = [{ ...from }];
      let branchX = from.x;
      for (let index = 1; index <= Math.round(random(3, 6)); index += 1) {
        branchX += away * random(6, 26) + random(-6, 6);
        branch.push({ x: branchX, y: from.y + index * random(16, 30) });
      }
      branches.push(branch);
    }
    return { startedAt: now, duration: random(420, 640), points, branches };
  }

  function lightningIntensity(now) {
    if (!nextLightningAt) nextLightningAt = now + random(1_200, 3_000);
    if (!lightning && now >= nextLightningAt) lightning = createLightning(now);
    if (!lightning) return 0;
    const elapsed = now - lightning.startedAt;
    if (elapsed >= lightning.duration) {
      lightning = null;
      nextLightningAt = now + random(2_600, 7_000);
      return 0;
    }
    // Короткий первый удар и более слабый повтор читаются естественнее
    // равномерного мигания.
    const first = Math.max(0, 1 - Math.abs(elapsed - 46) / 46);
    const second = Math.max(0, 1 - Math.abs(elapsed - 170) / 74) * 0.62;
    const afterglow = Math.max(0, 1 - elapsed / lightning.duration) * 0.14;
    return Math.min(1, first + second + afterglow);
  }

  /* Канал сужается и гаснет книзу: постоянная толщина превращала разряд в
     арматуру, а слишком резкое сужение обрывало его на середине. */
  function traceLightning(points, base, alpha, color) {
    const last = points.length - 1;
    for (let index = 1; index <= last; index += 1) {
      const fade = 1 - (index / last) * 0.4;
      context.strokeStyle = `rgba(${color}, ${alpha * fade})`;
      context.lineWidth = Math.max(0.9, base * (1 - (index / last) * 0.45));
      context.beginPath();
      context.moveTo(points[index - 1].x, points[index - 1].y);
      context.lineTo(points[index].x, points[index].y);
      context.stroke();
    }
  }

  function drawLightning(now) {
    const intensity = lightningIntensity(now);
    if (!intensity || !lightning) return;
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    context.lineJoin = "round";

    // вспышка освещает всю сцену, и сильнее там, где тучи
    const sky = context.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, `rgba(188, 218, 252, ${0.5 * intensity})`);
    sky.addColorStop(0.55, `rgba(150, 190, 235, ${0.26 * intensity})`);
    sky.addColorStop(1, `rgba(120, 160, 205, ${0.1 * intensity})`);
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    const life = Math.max(
      intensity,
      0.5 * Math.max(0, 1 - (now - lightning.startedAt) / lightning.duration),
    );
    const paths = [lightning.points, ...lightning.branches];
    // ореол размыт: разряд виден сквозь мутное стекло, а не наклеен поверх
    context.filter = "blur(7px)";
    for (const path of paths) traceLightning(path, 20, 0.5 * life, "128, 184, 245");
    context.filter = "blur(1.6px)";
    for (const path of paths) traceLightning(path, 6, 0.85 * life, "198, 228, 255");
    context.filter = "none";
    for (const path of paths) traceLightning(path, 2.2, Math.min(1, 1.15 * life), "252, 254, 255");
    context.restore();
  }

  function step(now) {
    frame = window.requestAnimationFrame(step);
    if (!imageReady) return;
    const delta = Math.min(0.05, lastTime ? (now - lastTime) / 1000 : 0.016);
    lastTime = now;

    // стекло затягивается обратно: без этого дорожки вытягивались во весь
    // экран и превращались в прочерченные линии
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = Math.min(0.62, 0.34 * delta * 60);
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

      const previousX = drop.x;
      const previousY = drop.y;
      drop.speed = Math.min(drop.maxSpeed, drop.speed + drop.maxSpeed * 5.6 * delta);
      drop.y += drop.speed * delta;
      drop.x += (
        drop.wind * drop.speed
        + Math.sin(drop.life * drop.wobbleSpeed + drop.wobble) * drop.drift
      ) * delta;

      /* След уже головы и стирает запотевание не насквозь: сплошная полоса во
         всю толщину капли читалась прочерченной палкой, а не влажным следом. */
      context.globalAlpha = 0.5;
      context.lineWidth = Math.max(0.6, drop.size * 0.34 * drop.trail);
      context.beginPath();
      context.moveTo(previousX, previousY);
      context.lineTo(drop.x, drop.y);
      context.stroke();
      context.globalAlpha = 1;
      drawDropHead(context, drop, 1 + Math.min(0.55, drop.speed / 900));
      if (drop.speed > 70 && Math.random() < 5 * delta) addBead(drop);

      // случайная остановка: капля цепляется за неровность и снова копит массу
      if (!drop.heavy && Math.random() < 0.24 * delta) {
        drop.speed = 0;
        drop.rest = random(0.08, 0.48);
      }
      if (drop.y - drop.size * 2 > height || drop.x - drop.size > width) {
        Object.assign(drop, spawnDrop());
      }
    }

    for (let index = beads.length - 1; index >= 0; index -= 1) {
      const bead = beads[index];
      bead.life -= delta;
      if (bead.life <= 0) {
        beads.splice(index, 1);
        continue;
      }
      context.globalAlpha = Math.min(1, bead.life);
      context.beginPath();
      context.ellipse(bead.x, bead.y, bead.size, bead.size * 1.15, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;

    // объём: тёмная кромка снизу и блик сверху, иначе стёртая голова — клякса
    context.globalCompositeOperation = "source-over";
    for (const drop of drops) {
      const sprite = lens(drop.size);
      const box = sprite.width;
      context.drawImage(sprite, drop.x - box / 2, drop.y - box / 2, box, box);
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
