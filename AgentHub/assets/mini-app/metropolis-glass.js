"use strict";

(() => {
  const root = document.documentElement;
  const atmosphere = document.querySelector(".theme-atmosphere");
  const canvas = atmosphere?.querySelector("[data-metropolis-glass]");
  if (!atmosphere || !canvas) return;

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
    uniform sampler2D uImage;
    uniform sampler2D uFogImage;
    uniform vec2 uViewport;
    uniform vec2 uImageSize;
    uniform float uTime;
    uniform float uFocusX;

    const float TAU = 6.28318530718;

    float hash21(vec2 value) {
      value = fract(value * vec2(127.1, 311.7));
      value += dot(value, value + 34.17);
      return fract(value.x * value.y);
    }

    vec2 coverUv(vec2 uv) {
      float scale = max(uViewport.x / uImageSize.x, uViewport.y / uImageSize.y);
      vec2 visible = uViewport / (uImageSize * scale);
      vec2 covered = (uv - 0.5) * visible + 0.5;
      covered.x += (uFocusX - 0.5) * (1.0 - visible.x);
      return covered;
    }

    vec4 rainLayer(vec2 uv0, float time) {
      vec2 gridAspect = vec2(2.0, 1.0);
      vec2 gridUv = uv0 * 3.0 * gridAspect;
      gridUv.y += time * 0.25;

      vec2 cellUv = fract(gridUv) - 0.5;
      vec2 cellId = floor(gridUv);
      float noise = hash21(cellId);
      time += noise * TAU;

      float wave = uv0.y * 10.0;
      float x = (noise - 0.5) * 0.8;
      x += (0.4 - abs(x))
        * sin(3.0 * wave)
        * pow(sin(wave), 6.0)
        * 0.45;
      float y = -sin(time + sin(time + sin(time) * 0.5)) * (0.5 - 0.06);
      y -= (cellUv.x - x) * (cellUv.x - x);

      // The original pen assumes a wide 2:1 canvas. AgentHub can be a narrow
      // VS Code panel, so convert the cell distance to physical screen space.
      float screenCorrection = max(
        (uViewport.x / max(uViewport.y, 1.0)) / gridAspect.x,
        0.16
      );
      vec2 screenScale = vec2(screenCorrection, 1.0);
      vec2 dropPosition = (cellUv - vec2(x, y)) * screenScale;
      float drop = smoothstep(0.03, 0.02, length(dropPosition));

      vec2 trailPosition = (cellUv - vec2(x, time * 0.25)) * screenScale;
      trailPosition.y = (fract(trailPosition.y * 8.0) - 0.5) / 8.0;
      float trail = smoothstep(0.02, 0.015, length(trailPosition));

      float clearTrail = smoothstep(-0.05, 0.05, dropPosition.y);
      clearTrail *= smoothstep(0.5, y, cellUv.y);
      trail *= clearTrail;
      clearTrail *= smoothstep(0.026, 0.012, abs(dropPosition.x));

      // Only the rounded head works as a strong lens. Refracting every trail
      // bead produces the metallic "strings of pearls" visible in the old
      // narrow-screen rendering.
      vec2 refraction = drop * dropPosition * vec2(0.9, 0.62);
      refraction += clearTrail * vec2(dropPosition.x * 0.035, 0.0);
      return vec4(refraction, clearTrail, drop);
    }

    void main() {
      vec2 screenUv = vUv;
      vec2 imageUv = coverUv(screenUv);
      float time = mod(uTime * 1.8, 7200.0);

      vec4 drops = rainLayer(screenUv, time);
      drops += rainLayer(screenUv * 1.25 + 7.54, time * 0.91 + 1.7);
      drops += rainLayer(screenUv * 1.35 + 1.54, time * 1.08 + 4.2);
      drops += rainLayer(screenUv * 1.57 - 7.54, time * 0.84 + 7.6);

      float trailClarity = smoothstep(0.02, 0.82, clamp(drops.z, 0.0, 1.0));
      float dropClarity = smoothstep(0.04, 0.9, clamp(drops.w, 0.0, 1.0));
      float clearGlass = clamp(trailClarity * 0.62 + dropClarity * 0.94, 0.0, 1.0);
      vec2 refractedUv = imageUv + drops.xy * 1.65;

      vec4 fogged = texture2D(uFogImage, imageUv);
      vec4 clear = texture2D(uImage, refractedUv);
      gl_FragColor = vec4(mix(fogged.rgb, clear.rgb, clearGlass), 1.0);
    }
  `;

  let context = null;
  let program = null;
  let texture = null;
  let fogTexture = null;
  let imageSize = [1, 1];
  let frame = 0;
  let startedAt = 0;
  let ready = false;
  let initializing = false;
  let locations = null;

  function cssUrl(value) {
    const match = String(value ?? "").trim().match(/^url\((['"]?)(.*)\1\)$/u);
    return match?.[2] ?? "";
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
    const nextProgram = context.createProgram();
    const vertex = compile(context.VERTEX_SHADER, vertexSource);
    const fragment = compile(context.FRAGMENT_SHADER, fragmentSource);
    context.attachShader(nextProgram, vertex);
    context.attachShader(nextProgram, fragment);
    context.linkProgram(nextProgram);
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    if (context.getProgramParameter(nextProgram, context.LINK_STATUS)) return nextProgram;
    const message = context.getProgramInfoLog(nextProgram) || "shader link failed";
    context.deleteProgram(nextProgram);
    throw new Error(message);
  }

  function resize() {
    if (!context) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(window.innerWidth * pixelRatio));
    const height = Math.max(1, Math.round(window.innerHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.viewport(0, 0, width, height);
  }

  function draw(now = window.performance.now()) {
    frame = 0;
    if (!ready || root.dataset.theme !== "metropolis" || document.hidden) return;
    resize();
    context.useProgram(program);
    context.uniform2f(locations.viewport, canvas.width, canvas.height);
    context.uniform2f(locations.imageSize, imageSize[0], imageSize[1]);
    context.uniform1f(locations.time, reducedMotion.matches ? 0 : (now - startedAt) / 1000);
    context.uniform1f(
      locations.focusX,
      window.innerWidth < window.innerHeight ? 0.67 : 0.58,
    );
    context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
    atmosphere.dataset.ready = "true";
    if (!reducedMotion.matches) frame = window.requestAnimationFrame(draw);
  }

  function schedule() {
    if (root.dataset.theme !== "metropolis" || !ready || frame) return;
    frame = window.requestAnimationFrame(draw);
  }

  function createTexture(source, unit) {
    const nextTexture = context.createTexture();
    context.activeTexture(context.TEXTURE0 + unit);
    context.bindTexture(context.TEXTURE_2D, nextTexture);
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
    return nextTexture;
  }

  function createFogTexture(image) {
    const fogCanvas = document.createElement("canvas");
    const scale = 0.16;
    fogCanvas.width = Math.max(96, Math.round(image.naturalWidth * scale));
    fogCanvas.height = Math.max(64, Math.round(image.naturalHeight * scale));
    const fogContext = fogCanvas.getContext("2d", { alpha: false });
    if (!fogContext) return image;

    const margin = Math.max(4, Math.round(Math.min(fogCanvas.width, fogCanvas.height) * 0.045));
    fogContext.fillStyle = "#102633";
    fogContext.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
    fogContext.filter = "blur(4px) saturate(82%) brightness(88%)";
    fogContext.drawImage(
      image,
      -margin,
      -margin,
      fogCanvas.width + margin * 2,
      fogCanvas.height + margin * 2,
    );
    fogContext.filter = "none";
    fogContext.fillStyle = "rgba(132, 155, 163, 0.075)";
    fogContext.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
    return fogCanvas;
  }

  function upload(image) {
    texture = createTexture(image, 0);
    fogTexture = createTexture(createFogTexture(image), 1);
    context.uniform1i(locations.image, 0);
    context.uniform1i(locations.fogImage, 1);
    imageSize = [image.naturalWidth, image.naturalHeight];
    ready = true;
    startedAt = window.performance.now();
    schedule();
  }

  function initialize() {
    if (initializing || ready || root.dataset.theme !== "metropolis") return;
    initializing = true;
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
        image: context.getUniformLocation(program, "uImage"),
        fogImage: context.getUniformLocation(program, "uFogImage"),
        viewport: context.getUniformLocation(program, "uViewport"),
        imageSize: context.getUniformLocation(program, "uImageSize"),
        time: context.getUniformLocation(program, "uTime"),
        focusX: context.getUniformLocation(program, "uFocusX"),
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

      const source = cssUrl(
        window.getComputedStyle(root).getPropertyValue("--metropolis-image"),
      );
      if (!source) throw new Error("Metropolis texture is unavailable");
      const image = new Image();
      image.decoding = "async";
      image.addEventListener("load", () => upload(image), { once: true });
      image.addEventListener("error", () => {
        atmosphere.dataset.ready = "false";
      }, { once: true });
      image.src = source;
    } catch (error) {
      atmosphere.dataset.ready = "false";
      console.warn(`Agent Hub: ${error.message}`);
    } finally {
      initializing = false;
    }
  }

  function syncTheme() {
    if (root.dataset.theme === "metropolis") {
      initialize();
      schedule();
      return;
    }
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  }

  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("visibilitychange", syncTheme);
  reducedMotion.addEventListener?.("change", () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    schedule();
  });
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    ready = false;
    atmosphere.dataset.ready = "false";
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  });
  syncTheme();
})();
