"use strict";

/* Сцена темы «Storm».
 *
 * Стекла с каплями здесь нет: на ночном море оно давало муть поверх самого
 * шторма. Вместо него оживает сама сцена — вода дышит, небо медленно плывёт,
 * а разряд подсвечивает кадр вторым снимком той же сцены, снятым при вспышке.
 *
 * Всё рисует один фрагментный шейдер: два снимка, смещение UV по маске
 * горизонта и текстура канала молнии. Канал готовится в буфер один раз за
 * удар — покадровое размытие на 2D вешало кадр на телефоне. */
(() => {
  const root = document.documentElement;
  const atmosphere = document.querySelector(".theme-atmosphere");
  const canvas = atmosphere?.querySelector("[data-storm-glass]");
  if (!atmosphere || !canvas) return;

  const THEME = "stormglass";
  // доля высоты кадра, на которой лежит горизонт: выше него вода не колышется.
  // Значение измерено по самим снимкам: линия горизонта на них идёт по 63 %.
  const HORIZON = 0.63;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const vertexSource = `
    attribute vec2 aPosition;
    varying vec2 vUv;

    void main() {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
  const fragmentSource = `
    precision mediump float;

    varying vec2 vUv;
    uniform sampler2D uSea;
    uniform sampler2D uFlash;
    uniform sampler2D uBolt;
    uniform vec2 uViewport;
    uniform vec2 uImageSize;
    uniform float uTime;
    uniform float uFocusX;
    uniform float uHorizon;
    uniform float uStrike;

    vec2 coverUv(vec2 uv) {
      float scale = max(uViewport.x / uImageSize.x, uViewport.y / uImageSize.y);
      vec2 visible = uViewport / (uImageSize * scale);
      vec2 covered = (uv - 0.5) * visible + 0.5;
      covered.x += (uFocusX - 0.5) * (1.0 - visible.x);
      return covered;
    }

    void main() {
      // vUv идёт снизу вверх, поэтому вода — это малые значения y
      float depth = clamp((uHorizon - vUv.y) / max(uHorizon, 0.001), 0.0, 1.0);
      float water = pow(depth, 1.35);
      float t = uTime;

      /* Волны: две бегущие синусоиды разного периода и скорости. Амплитуда
         растёт к нижнему краю и обращается в ноль у горизонта, иначе линия
         горизонта дрожит и сцена сразу читается подделкой. */
      float swell = sin(vUv.x * 6.0 - t * 0.5) + sin(vUv.x * 15.0 + t * 0.85) * 0.55;
      float chop = sin((vUv.x * 30.0 + vUv.y * 26.0) + t * 1.8);
      float surge = sin(t * 0.42 + vUv.x * 2.4);
      vec2 uv = vUv;
      uv.x += (swell * 0.004 + chop * 0.0016) * water;
      // общий подъём и спад воды: без него рябь читается дрожанием картинки
      uv.y += (sin(vUv.x * 10.0 + t * 0.7) * 0.005 + chop * 0.0014 + surge * 0.004) * water;

      // небо живёт своей жизнью: очень медленный дрейф облаков вбок
      float sky = 1.0 - smoothstep(uHorizon - 0.04, uHorizon + 0.16, vUv.y);
      uv.x += sin(t * 0.06) * 0.0035 * (1.0 - sky);

      vec2 imageUv = coverUv(uv);
      vec3 calm = texture2D(uSea, imageUv).rgb;
      vec3 lit = texture2D(uFlash, imageUv).rgb;
      vec3 color = mix(calm, lit, clamp(uStrike, 0.0, 1.0));

      /* Гребни живут собственным светом: бегущая волна яркости по пене
         добавляет движение там, где смещение UV почти незаметно, и сильно
         вспыхивает в момент разряда. */
      float foam = smoothstep(0.3, 0.8, dot(calm, vec3(0.299, 0.587, 0.114)));
      float crest = 0.5 + 0.5 * sin(vUv.x * 9.0 - t * 1.15 + surge);
      color += foam * water * (crest * 0.12 + uStrike * 0.3);

      /* Канал гаснет вместе со вспышкой. Без множителя буфер прошлого удара
         оставался на экране до следующего. */
      vec4 bolt = texture2D(uBolt, vUv);
      color += bolt.rgb * bolt.a * clamp(uStrike * 1.6, 0.0, 1.0);
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  let context = null;
  let program = null;
  let locations = null;

  function motionEnabled() {
    return window.AgentHubBackgroundMotionPreference.enabled(root, reducedMotion);
  }
  let boltTexture = null;
  let imageSize = [1, 1];
  let ready = false;
  let initializing = false;
  let initialization = 0;
  let frame = 0;
  let startedAt = 0;
  let width = 0;
  let height = 0;
  let mobile = false;
  let nextLightningAt = 0;
  let lightning = null;
  const boltCanvas = document.createElement("canvas");

  function cssUrl(value) {
    const match = String(value ?? "").trim().match(/^url\((['"]?)(.*)\1\)$/u);
    return match?.[2] ?? "";
  }

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function compile(type, source) {
    const shader = context.createShader(type);
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (context.getShaderParameter(shader, context.COMPILE_STATUS)) return shader;
    const message = context.getShaderInfoLog(shader) || "shader compilation failed";
    context.deleteShader(shader);
    throw new Error(message);
  }

  function createProgram() {
    const next = context.createProgram();
    const vertex = compile(context.VERTEX_SHADER, vertexSource);
    const fragment = compile(context.FRAGMENT_SHADER, fragmentSource);
    context.attachShader(next, vertex);
    context.attachShader(next, fragment);
    context.linkProgram(next);
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    if (context.getProgramParameter(next, context.LINK_STATUS)) return next;
    const message = context.getProgramInfoLog(next) || "shader link failed";
    context.deleteProgram(next);
    throw new Error(message);
  }

  function createTexture(source, unit) {
    const texture = context.createTexture();
    context.activeTexture(context.TEXTURE0 + unit);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, true);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texImage2D(
      context.TEXTURE_2D,
      0,
      context.RGBA,
      context.RGBA,
      context.UNSIGNED_BYTE,
      source,
    );
    return texture;
  }

  function resize() {
    mobile = root.dataset.surface === "mobile" || window.innerWidth < 860;
    const ratio = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5);
    width = Math.max(1, Math.round(window.innerWidth * ratio));
    height = Math.max(1, Math.round(window.innerHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      boltCanvas.width = Math.max(1, Math.round(width * 0.5));
      boltCanvas.height = Math.max(1, Math.round(height * 0.5));
      lightning = null;
      uploadBolt();
    }
    context.viewport(0, 0, width, height);
  }

  function uploadBolt() {
    context.activeTexture(context.TEXTURE0 + 2);
    context.bindTexture(context.TEXTURE_2D, boltTexture);
    context.texImage2D(
      context.TEXTURE_2D,
      0,
      context.RGBA,
      context.RGBA,
      context.UNSIGNED_BYTE,
      boltCanvas,
    );
  }

  /* Канал ветвится мелким неровным шагом и сужается книзу: крупные колена и
     постоянная толщина читались нарисованной стрелкой. */
  function drawBolt() {
    const paint = boltCanvas.getContext("2d");
    const scale = boltCanvas.width / Math.max(width, 1);
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.clearRect(0, 0, boltCanvas.width, boltCanvas.height);
    paint.setTransform(scale, 0, 0, scale, 0, 0);
    paint.lineCap = "round";
    paint.lineJoin = "round";

    const startX = random(width * 0.12, width * 0.9);
    // разряд доходит до воды: горизонт лежит на 0.6 высоты кадра
    const endY = random(height * 0.58, height * 0.66);
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
    uploadBolt();
  }

  function strikeAt(now) {
    if (!nextLightningAt) nextLightningAt = now + random(4_000, 9_000);
    if (!lightning && now >= nextLightningAt) {
      lightning = { startedAt: now, duration: random(420, 640) };
      drawBolt();
    }
    if (!lightning) return 0;
    const elapsed = now - lightning.startedAt;
    if (elapsed >= lightning.duration) {
      lightning = null;
      // гроза бьёт редко: частые разряды превращали сцену в мигалку
      nextLightningAt = now + random(9_000, 24_000);
      return 0;
    }
    // короткий первый удар и более слабый повтор вместо равномерного мигания
    const first = Math.max(0, 1 - Math.abs(elapsed - 46) / 46);
    const second = Math.max(0, 1 - Math.abs(elapsed - 170) / 74) * 0.62;
    const afterglow = Math.max(0, 1 - elapsed / lightning.duration) * 0.16;
    return Math.min(1, first + second + afterglow);
  }

  function draw(now = window.performance.now()) {
    frame = 0;
    if (!ready || root.dataset.theme !== THEME || document.hidden) return;
    resize();
    const moving = motionEnabled();
    const strike = moving ? strikeAt(now) : 0;
    context.useProgram(program);
    context.uniform2f(locations.viewport, width, height);
    context.uniform2f(locations.imageSize, imageSize[0], imageSize[1]);
    context.uniform1f(locations.time, moving ? (now - startedAt) / 1000 : 0);
    context.uniform1f(locations.focusX, window.innerWidth < window.innerHeight ? 0.66 : 0.58);
    context.uniform1f(locations.horizon, 1 - HORIZON);
    context.uniform1f(locations.strike, strike);
    context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    atmosphere.dataset.ready = "true";
    if (moving) frame = window.requestAnimationFrame(draw);
  }

  function schedule() {
    if (root.dataset.theme !== THEME || !ready || frame) return;
    frame = window.requestAnimationFrame(draw);
  }

  function load(variable) {
    return new Promise((resolve, reject) => {
      const source = cssUrl(window.getComputedStyle(root).getPropertyValue(variable));
      if (!source) {
        reject(new Error(`${variable} is unavailable`));
        return;
      }
      const image = new Image();
      image.decoding = "async";
      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener("error", () => reject(new Error(`${variable} failed to load`)), {
        once: true,
      });
      image.src = source;
    });
  }

  async function initialize() {
    if (initializing || ready || root.dataset.theme !== THEME) return;
    initializing = true;
    const generation = ++initialization;
    try {
      context = canvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        powerPreference: "high-performance",
        premultipliedAlpha: false,
      });
      if (!context) throw new Error("WebGL is unavailable");
      program = createProgram();
      context.useProgram(program);

      const position = context.getAttribLocation(program, "aPosition");
      locations = {
        sea: context.getUniformLocation(program, "uSea"),
        flash: context.getUniformLocation(program, "uFlash"),
        bolt: context.getUniformLocation(program, "uBolt"),
        viewport: context.getUniformLocation(program, "uViewport"),
        imageSize: context.getUniformLocation(program, "uImageSize"),
        time: context.getUniformLocation(program, "uTime"),
        focusX: context.getUniformLocation(program, "uFocusX"),
        horizon: context.getUniformLocation(program, "uHorizon"),
        strike: context.getUniformLocation(program, "uStrike"),
      };
      const buffer = context.createBuffer();
      context.bindBuffer(context.ARRAY_BUFFER, buffer);
      context.bufferData(
        context.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        context.STATIC_DRAW,
      );
      context.enableVertexAttribArray(position);
      context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);

      const [sea, flash] = await Promise.all([
        load("--stormglass-image"),
        load("--stormglass-flash"),
      ]);
      if (
        generation !== initialization
        || context?.isContextLost?.()
        || root.dataset.theme !== THEME
      ) return;
      createTexture(sea, 0);
      createTexture(flash, 1);
      boltCanvas.width = Math.max(1, Math.round(window.innerWidth * 0.5));
      boltCanvas.height = Math.max(1, Math.round(window.innerHeight * 0.5));
      boltTexture = createTexture(boltCanvas, 2);
      context.uniform1i(locations.sea, 0);
      context.uniform1i(locations.flash, 1);
      context.uniform1i(locations.bolt, 2);
      imageSize = [sea.naturalWidth, sea.naturalHeight];
      ready = true;
      startedAt = window.performance.now();
      schedule();
    } catch (error) {
      // без шейдера остаётся CSS-фон, поэтому тема не выглядит сломанной
      atmosphere.dataset.ready = "false";
      console.warn(`Agent Hub: ${error.message}`);
    } finally {
      initializing = false;
    }
  }

  function sync() {
    const active = root.dataset.theme === THEME;
    atmosphere.dataset.stormGlass = active ? "true" : "false";
    if (!active) {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      lightning = null;
      nextLightningAt = 0;
      return;
    }
    if (!motionEnabled()) {
      lightning = null;
      nextLightningAt = 0;
    }
    initialize();
    schedule();
  }

  new MutationObserver(sync).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme", "data-background-motion"],
  });
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("focus", sync);
  window.addEventListener("pageshow", sync);
  document.addEventListener("visibilitychange", sync);
  reducedMotion.addEventListener?.("change", () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    schedule();
  });
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    initialization += 1;
    ready = false;
    initializing = false;
    context = null;
    program = null;
    locations = null;
    boltTexture = null;
    atmosphere.dataset.ready = "false";
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  });
  canvas.addEventListener("webglcontextrestored", sync);
  sync();
})();
