"use strict";

/* Запотевшее стекло темы «Storm».
 *
 * Отличия от стекла «Мегаполиса» — по замечаниям с обсуждения:
 *   • капли не круглые: голова вытянута и сужается кверху, за ней остаётся
 *     влажная дорожка;
 *   • движение несинхронное: капля висит, копит массу и срывается в свой
 *     момент, а не едет вместе со всеми по общей сетке;
 *   • стекло не «отмывается» насовсем: протёртое зарастает, но медленно,
 *     поэтому дорожки живут долго и исчезают по одной.
 *
 * Физика честная: слой рисует размытую копию снимка (запотевание), капли
 * стирают её (destination-out) и открывают резкую картинку, а крупная капля
 * дополнительно работает линзой — показывает окрестность перевёрнутой.
 * Обе копии снимка готовятся один раз на изменение размера.
 *
 * В горячем пути нет ни одного canvas-фильтра: размытие дорого на мобильных
 * GPU и вешало кадр при каждом разряде. Молния целиком рисуется в буфер один
 * раз за удар, а покадрово только накладывается. */
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
  let mobile = false;
  let trailLife = 7;
  const TRAIL_ALPHA = [0.5, 0.32, 0.16];
  // геометрия кадра фотографии: нужна и запотеванию, и линзе
  const scene = { x: 0, y: 0, width: 0, height: 0 };
  const drops = [];
  /* Бисер, оставленный прошедшей каплей: без него дорожка читается голой
     полосой, а на настоящем стекле за каплей всегда тянется мелочь. */
  const beads = [];
  const beadLimit = () => (mobile ? 80 : 200);
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
    const heavy = Math.random() < 0.32;
    const size = heavy ? random(9, 18) : random(3, 7.5);
    return {
      x: random(-0.02, 1.02) * width,
      y: initial ? random(-0.1, 1) * height : random(-0.2, -0.02) * height,
      size,
      speed: 0,
      maxSpeed: heavy ? random(190, 420) : random(85, 220),
      rest: heavy ? random(0, 0.4) : random(0, 1.4),
      wobble: random(0, Math.PI * 2),
      wobbleSpeed: random(1.1, 3.6),
      drift: random(-4, 5),
      wind: random(0.04, 0.09),
      trail: heavy ? random(0.85, 1.25) : random(0.55, 0.95),
      heavy,
      travel: 0,
      beadGap: random(26, 90),
      path: [],
      life: 0,
    };
  }

  function resize() {
    mobile = root.dataset.surface === "mobile" || window.innerWidth < 860;
    // на телефоне холст размером с экран в три пикселя на точку — самый
    // дорогой кадр во всей теме, поэтому плотность ограничена жёстко
    const ratio = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5);
    width = Math.max(1, Math.round(window.innerWidth));
    height = Math.max(1, Math.round(window.innerHeight));
    scale = ratio;
    for (const layer of [canvas, fog]) {
      layer.width = Math.round(width * ratio);
      layer.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    fogContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    trailLife = mobile ? 3.5 : 7;
    paintScene();

    const target = Math.round((width * height) / (mobile ? 12_000 : 6_400));
    const wanted = reducedMotion.matches
      ? 0
      : Math.max(mobile ? 30 : 80, Math.min(mobile ? 50 : 190, target));
    while (drops.length > wanted) drops.pop();
    while (drops.length < wanted) drops.push(spawnDrop(true));
    beads.length = 0;
    lenses.clear();
    lightning = null;
    if (imageReady) {
      context.globalCompositeOperation = "copy";
      context.drawImage(fog, 0, 0, width, height);
    }
  }

  /* Размытая копия фона плюс холодная плёнка — это и есть запотевание. Оно
     плотное намеренно: сквозь стекло должно быть видно шторм, а не читаемую
     фотографию, иначе интерфейс тонет в деталях. */
  function paintScene() {
    if (!imageReady || !width || !height) return;
    const cover = Math.max(width / image.width, height / image.height);
    const drawWidth = image.width * cover;
    const drawHeight = image.height * cover;
    // кадр смещён к правому краю: там маяк, и его свет собирают капли
    const offsetX = (width - drawWidth) * 0.62;
    const offsetY = (height - drawHeight) * 0.5;

    scene.x = offsetX;
    scene.y = offsetY;
    scene.width = drawWidth;
    scene.height = drawHeight;

    fogContext.setTransform(scale, 0, 0, scale, 0, 0);
    fogContext.clearRect(0, 0, width, height);
    fogContext.filter = "blur(13px) saturate(0.8) brightness(0.86)";
    fogContext.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
    fogContext.filter = "none";
    fogContext.fillStyle = "rgba(198, 218, 238, 0.2)";
    fogContext.fillRect(0, 0, width, height);
  }

  function dropPath(target, drop, stretch = 1) {
    const rx = drop.size * 0.72;
    const ry = drop.size * stretch;
    target.beginPath();
    /* Голова — вытянутый эллипс, сверху сходится в носик. Носик короткий:
       длинный превращал каплю в стеклянную стрелку. */
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
  }

  /* Объём капли — готовый спрайт: создавать градиенты на каждую каплю в кадре
     дорого, а размеров всего десятка полтора. Кромка по краю и есть то, что
     превращает пятно в каплю. */
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
    const rx = key * 0.86;
    const ry = key * 1.08;

    // тень под каплей: она лежит на стекле и отбрасывает мягкое пятно
    const shade = paint.createRadialGradient(
      middle, middle + key * 0.35, key * 0.2,
      middle, middle + key * 0.35, key * 1.6,
    );
    shade.addColorStop(0, "rgba(6, 12, 20, 0.34)");
    shade.addColorStop(1, "rgba(6, 12, 20, 0)");
    paint.fillStyle = shade;
    paint.fillRect(0, 0, box, box);

    // светлая кромка по контуру — главный признак выпуклой капли
    paint.lineWidth = Math.max(0.7, key * 0.16);
    paint.strokeStyle = "rgba(226, 243, 255, 0.5)";
    paint.beginPath();
    paint.ellipse(middle, middle, rx, ry, 0, 0, Math.PI * 2);
    paint.stroke();
    paint.lineWidth = Math.max(0.5, key * 0.1);
    paint.strokeStyle = "rgba(10, 20, 32, 0.4)";
    paint.beginPath();
    paint.ellipse(middle, middle + key * 0.12, rx * 0.99, ry * 0.99, 0, 0.45, Math.PI - 0.45);
    paint.stroke();

    // компактный блик: капля собирает свет маяка в точку, а не светится вся
    const glare = paint.createRadialGradient(
      middle - key * 0.36, middle - key * 0.46, 0,
      middle - key * 0.36, middle - key * 0.46, key * 0.62,
    );
    glare.addColorStop(0, "rgba(244, 251, 255, 0.95)");
    glare.addColorStop(0.45, "rgba(210, 234, 250, 0.28)");
    glare.addColorStop(1, "rgba(210, 234, 250, 0)");
    paint.fillStyle = glare;
    paint.beginPath();
    paint.ellipse(middle - key * 0.3, middle - key * 0.38, rx * 0.62, ry * 0.5, 0, 0, Math.PI * 2);
    paint.fill();

    lenses.set(key, sprite);
    return sprite;
  }

  /* Настоящая линза: внутри капли окрестность перевёрнута и увеличена.
     Дорогая операция (clip + перерисовка кадра), поэтому только для крупных
     капель и только на десктопе. */
  function refract(drop, stretch) {
    context.save();
    dropPath(context, drop, stretch);
    context.clip();
    context.translate(drop.x, drop.y);
    context.scale(-1.6, -1.6);
    context.translate(-drop.x, -drop.y);
    context.globalAlpha = 0.85;
    context.drawImage(image, scene.x, scene.y, scene.width, scene.height);
    context.restore();
  }

  /* Дорожка хранится точками с временем, а не выжигается в пикселях. Слой с
     накоплением давал цветной мусор: полупрозрачные наложения в 8 битах
     теряют точность, и в почти прозрачных дорожках вылезал шум. */
  function trackTrail(drop, now) {
    const path = drop.path;
    const last = path[path.length - 1];
    if (!last || Math.hypot(drop.x - last.x, drop.y - last.y) > (mobile ? 26 : 12)) {
      path.push({ x: drop.x, y: drop.y, at: now });
    }
    while (path.length && now - path[0].at > trailLife) path.shift();
  }

  /* Дорожка стирает запотевание тем слабее, чем старше её участок. Возрастные
     ступени вместо посегментной альфы: иначе на кадр приходятся десятки тысяч
     обводок. */
  function drawTrail(drop, now) {
    const path = drop.path;
    if (path.length < 2) return;
    context.lineWidth = Math.max(0.6, drop.size * 0.5 * drop.trail);
    let start = 0;
    let band = trailBand(now - path[0].at);
    for (let index = 1; index <= path.length; index += 1) {
      const next = index < path.length ? trailBand(now - path[index].at) : -1;
      if (next === band && index < path.length) continue;
      context.globalAlpha = TRAIL_ALPHA[band];
      context.beginPath();
      context.moveTo(path[start].x, path[start].y);
      for (let step = start + 1; step <= index && step < path.length; step += 1) {
        context.lineTo(path[step].x, path[step].y);
      }
      if (index === path.length) {
        context.lineTo(drop.x, drop.y);
      }
      context.stroke();
      start = index - 1;
      band = next;
    }
    context.globalAlpha = 1;
  }

  function trailBand(age) {
    if (age < trailLife * 0.35) return 0;
    return age < trailLife * 0.7 ? 1 : 2;
  }

  function addBead(drop) {
    if (beads.length >= beadLimit()) beads.shift();
    beads.push({
      x: drop.x + random(-0.9, 0.9) * drop.size,
      y: drop.y - random(0.4, 3.2) * drop.size,
      size: Math.max(0.7, drop.size * random(0.12, 0.3)),
      life: random(5, 14),
    });
  }

  /* Разряд рисуется один раз в буфер половинного разрешения: при наложении он
     растягивается и получает мягкость даром, без покадрового размытия. */
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
      // мелкий неровный шаг: крупные колена читались нарисованной стрелкой
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

    /* Свечение набирается проходами разной ширины: канал сужается и гаснет
       книзу, иначе разряд читается арматурой одинаковой толщины. */
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

  function lightningIntensity(now) {
    if (!nextLightningAt) nextLightningAt = now + random(1_200, 3_000);
    if (!lightning && now >= nextLightningAt) lightning = createLightning(now);
    if (!lightning) return 0;
    const elapsed = now - lightning.startedAt;
    if (elapsed >= lightning.duration) {
      lightning = null;
      nextLightningAt = now + random(3_000, 8_000);
      return 0;
    }
    // Короткий первый удар и более слабый повтор читаются естественнее
    // равномерного мигания.
    const first = Math.max(0, 1 - Math.abs(elapsed - 46) / 46);
    const second = Math.max(0, 1 - Math.abs(elapsed - 170) / 74) * 0.62;
    const afterglow = Math.max(0, 1 - elapsed / lightning.duration) * 0.14;
    return Math.min(1, first + second + afterglow);
  }

  function drawLightning(now) {
    const intensity = lightningIntensity(now);
    if (!intensity || !lightning) return;
    context.save();
    context.globalCompositeOperation = "screen";
    // вспышка освещает всю сцену, и сильнее там, где тучи
    const sky = context.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, `rgba(188, 218, 252, ${0.46 * intensity})`);
    sky.addColorStop(0.55, `rgba(150, 190, 235, ${0.24 * intensity})`);
    sky.addColorStop(1, `rgba(120, 160, 205, ${0.09 * intensity})`);
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = Math.max(
      intensity,
      0.5 * Math.max(0, 1 - (now - lightning.startedAt) / lightning.duration),
    );
    context.drawImage(lightning.bolt, 0, 0, width, height);
    context.restore();
  }

  function step(now) {
    frame = window.requestAnimationFrame(step);
    if (!imageReady) return;
    const delta = Math.min(0.05, lastTime ? (now - lastTime) / 1000 : 0.016);
    lastTime = now;

    const seconds = now / 1000;

    for (const drop of drops) {
      drop.life += delta;
      if (drop.rest > 0) {
        drop.rest -= delta;
        // висящая капля чуть подрагивает — этого хватает, чтобы поток не читался ровным
        drop.x += Math.sin(drop.life * drop.wobbleSpeed + drop.wobble) * 0.12;
        continue;
      }

      const previousY = drop.y;
      drop.speed = Math.min(drop.maxSpeed, drop.speed + drop.maxSpeed * 5.6 * delta);
      drop.y += drop.speed * delta;
      drop.x += (
        drop.wind * drop.speed
        + Math.sin(drop.life * drop.wobbleSpeed + drop.wobble) * drop.drift
      ) * delta;
      trackTrail(drop, seconds);

      /* Бисер отмеряется пройденным путём, а не временем: по времени он
         ложился сплошной цепочкой и превращал дорожку в застёжку. */
      drop.travel += Math.abs(drop.y - previousY);
      if (drop.travel > drop.beadGap) {
        drop.travel = 0;
        drop.beadGap = random(26, 90);
        addBead(drop);
      }

      // случайная остановка: капля цепляется за неровность и снова копит массу
      if (!drop.heavy && Math.random() < 0.24 * delta) {
        drop.speed = 0;
        drop.rest = random(0.08, 0.48);
      }
      if (drop.y - drop.size * 2 > height || drop.x - drop.size > width) {
        const born = spawnDrop();
        born.path = [];
        Object.assign(drop, born);
      }
    }

    for (let index = beads.length - 1; index >= 0; index -= 1) {
      if ((beads[index].life -= delta) <= 0) beads.splice(index, 1);
    }

    /* Кадр собирается заново: запотевание кладётся целиком, а всё мокрое
       вырезается из него по состоянию, которое живёт в объектах. Накопление
       прямо в пикселях давало цветной мусор — в почти прозрачных дорожках
       вылезала ошибка округления восьмибитных каналов. */
    context.globalCompositeOperation = "copy";
    context.globalAlpha = 1;
    context.drawImage(fog, 0, 0, width, height);

    context.globalCompositeOperation = "destination-out";
    context.fillStyle = "#000";
    context.strokeStyle = "#000";
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const drop of drops) drawTrail(drop, seconds);
    for (const bead of beads) {
      context.globalAlpha = Math.min(0.85, bead.life * 0.35);
      context.beginPath();
      context.ellipse(bead.x, bead.y, bead.size, bead.size * 1.15, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    for (const drop of drops) {
      dropPath(context, drop, 1 + Math.min(0.55, drop.speed / 900));
      context.fill();
    }

    context.globalCompositeOperation = "source-over";
    for (const drop of drops) {
      if (!mobile && drop.heavy) refract(drop, 1 + Math.min(0.55, drop.speed / 900));
      const sprite = lens(drop.size);
      const box = sprite.width;
      context.drawImage(sprite, drop.x - box / 2, drop.y - box / 2, box, box);
    }
    // на телефоне бисер остаётся только следом в запотевании: две сотни
    // спрайтов на кадр там дороже, чем весь остальной шторм
    if (!mobile) {
      for (const bead of beads) {
        const sprite = lens(bead.size);
        const box = sprite.width;
        context.drawImage(sprite, bead.x - box / 2, bead.y - box / 2, box, box);
      }
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
