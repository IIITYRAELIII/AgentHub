import {
  createStartupReconnectModel,
  createStartupScreenModel,
  formatStartupElapsed,
} from "/startup-screen-model.js";

const startupHost = String(globalThis.location?.hostname ?? "").toLowerCase();
if (["127.0.0.1", "localhost", "::1"].includes(startupHost)) {
const root = document.documentElement;
const screen = document.createElement("section");
screen.className = "hub-startup-screen";
screen.setAttribute("role", "status");
screen.setAttribute("aria-live", "polite");
screen.hidden = true;
screen.innerHTML = `
  <main class="hub-startup-shell">
    <section class="hub-startup-hero">
      <canvas class="hub-startup-flow" aria-hidden="true"></canvas>
      <div class="hub-startup-hero-content">
        <div class="hub-startup-eyebrow">Agent Hub запускается</div>
        <h1 class="hub-startup-title">Проверка состояния</h1>
        <div class="hub-startup-dial" aria-hidden="true">
          <div class="hub-startup-dial-halo"></div>
          <div class="hub-startup-dial-orbit"></div>
          <div class="hub-startup-dial-ping"></div>
          <div class="hub-startup-dial-ping is-second"></div>
          <svg class="hub-startup-dial-svg" viewBox="0 0 252 252">
            <defs>
              <linearGradient id="hub-startup-arc-active" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#96dcff"></stop>
                <stop offset="100%" stop-color="#3f9bf5"></stop>
              </linearGradient>
            </defs>
            <circle class="hub-startup-dial-track" cx="126" cy="126" r="101"></circle>
            <g class="hub-startup-dial-segments"></g>
          </svg>
          <div class="hub-startup-dial-core">
            <img src="/agent-hub-mark.png" alt="">
          </div>
        </div>
        <div class="hub-startup-meta">
          <span class="hub-startup-timer">00:00:00</span>
          <span class="hub-startup-meta-separator"></span>
          <span class="hub-startup-stage-count">0 из 0 этапов</span>
        </div>
      </div>
    </section>
    <section class="hub-startup-completed">
      <div class="hub-startup-section-label">Завершено</div>
      <div class="hub-startup-completed-list"></div>
    </section>
    <section class="hub-startup-queue">
      <div class="hub-startup-section-label">Далее</div>
      <ol class="hub-startup-queue-list"></ol>
    </section>
  </main>
`;

document.body.append(screen);

const eyebrow = screen.querySelector(".hub-startup-eyebrow");
const title = screen.querySelector(".hub-startup-title");
const timer = screen.querySelector(".hub-startup-timer");
const stageCount = screen.querySelector(".hub-startup-stage-count");
const completedSection = screen.querySelector(".hub-startup-completed");
const completedList = screen.querySelector(".hub-startup-completed-list");
const queueSection = screen.querySelector(".hub-startup-queue");
const queueList = screen.querySelector(".hub-startup-queue-list");
const segmentGroup = screen.querySelector(".hub-startup-dial-segments");
const canvas = screen.querySelector(".hub-startup-flow");
const context = canvas.getContext("2d");
const radius = 101;
const circumference = 2 * Math.PI * radius;

/* Просвет между дугами задаётся долей самой дуги: при 17 операциях
   фиксированные 9 единиц съедали четверть сегмента и кольцо читалось
   как пунктир. */
function segmentGap(span) {
  return Math.min(9, Math.max(4.5, span * 0.16));
}

let segments = [];
let renderedCompleted = [];
let renderedQueue = "";
let currentModel = null;
let currentOperationId = "";
let hadStartup = false;
let hideTimer = 0;
let pollTimer = 0;
let stopped = false;
let observedHealth = false;
let consecutiveFailures = 0;
let reconnectStartedAtMs = 0;

const ACTIVE_POLL_MS = 500;
const READY_POLL_MS = 1_500;
const RETRY_POLL_MS = 800;
const RECONNECT_FAILURE_THRESHOLD = 2;

function ensureSegments(count) {
  if (segments.length === count) return;
  segmentGroup.replaceChildren();
  segments = Array.from({ length: count }, (_, index) => {
    const span = circumference / count;
    const gap = segmentGap(span);
    const segment = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    segment.setAttribute("class", "hub-startup-dial-segment");
    segment.setAttribute("cx", "126");
    segment.setAttribute("cy", "126");
    segment.setAttribute("r", String(radius));
    segment.setAttribute("transform", "rotate(-90 126 126)");
    segment.setAttribute("stroke-dasharray", `${span - gap} ${circumference - span + gap}`);
    segment.setAttribute("stroke-dashoffset", String(-(index * span) - gap / 2));
    segmentGroup.append(segment);
    return segment;
  });
}

function doneMark(failed) {
  const mark = document.createElement("span");
  mark.className = "hub-startup-done-mark";
  mark.innerHTML = failed
    ? '<svg viewBox="0 0 12 12"><path d="M3 3 9 9M9 3 3 9"></path></svg>'
    : '<svg viewBox="0 0 12 12"><path d="M2.6 6.3 4.9 8.6 9.4 3.6"></path></svg>';
  return mark;
}

function completedItem(model, operation, delayMs) {
  const item = document.createElement("div");
  const failed = operation.state === "failed";
  item.className = `hub-startup-completed-item${failed ? " is-failed" : ""}`;
  item.style.animationDelay = `${delayMs}ms`;
  const number = document.createElement("span");
  number.className = "hub-startup-done-number";
  number.textContent = String(model.operations.indexOf(operation) + 1);
  const label = document.createElement("span");
  label.className = "hub-startup-done-label";
  label.textContent = operation.label;
  item.append(doneMark(failed), number, label);
  return item;
}

/* Опрос /health идёт каждые 500 мс. Пересборка списков на каждом ответе
   перезапускала бы появление завершённых операций и бегущую нить активной
   строки, поэтому DOM меняется только при фактической смене состава. */
function renderCompleted(model) {
  /* Пока ничего не завершено, пустая рамка с заголовком читалась бы как дыра. */
  completedSection.hidden = model.completedOperations.length === 0;
  const keys = model.completedOperations.map((operation) => `${operation.id}:${operation.state}`);
  if (keys.length === renderedCompleted.length
    && keys.every((key, index) => key === renderedCompleted[index])) return;

  const appendOnly = keys.length > renderedCompleted.length
    && renderedCompleted.every((key, index) => key === keys[index]);
  if (appendOnly) {
    const added = model.completedOperations.slice(renderedCompleted.length);
    completedList.append(...added.map((operation, index) => (
      completedItem(model, operation, Math.min(index * 45, 260))
    )));
  } else {
    completedList.replaceChildren(...model.completedOperations.map((operation, index) => (
      completedItem(model, operation, Math.min(index * 45, 260))
    )));
  }
  renderedCompleted = keys;
}

function renderQueue(model) {
  queueSection.hidden = model.queueOperations.length === 0;
  const signature = `${model.currentIndex}|${model.queueOperations.map((operation) => operation.id).join(",")}`;
  if (signature === renderedQueue) return;
  renderedQueue = signature;
  queueList.replaceChildren(...model.queueOperations.map((operation, index) => {
    const item = document.createElement("li");
    item.className = `hub-startup-queue-item${index === 0 ? " is-running" : ""}`;
    const marker = document.createElement("span");
    marker.className = "hub-startup-queue-marker";
    const number = document.createElement("span");
    number.className = "hub-startup-queue-number";
    number.textContent = String(model.currentIndex + index + 1);
    const label = document.createElement("span");
    label.className = "hub-startup-queue-label";
    label.textContent = operation.label;
    item.append(marker, number, label);
    return item;
  }));
}

function updateQueueOverflow() {
  queueSection.classList.toggle(
    "is-scrollable",
    queueSection.scrollHeight - queueSection.clientHeight > 1,
  );
}

function renderSegments(model) {
  ensureSegments(model.operations.length);
  segments.forEach((segment, index) => {
    const operation = model.operations[index];
    let state = operation.state;
    if (index === model.currentIndex && state === "pending") state = "running";
    segment.setAttribute("class", `hub-startup-dial-segment is-${state}`);
  });
}

function applyModel(model) {
  currentModel = model;
  eyebrow.textContent = model.eyebrow;
  title.textContent = model.title;
  timer.textContent = model.elapsed;
  stageCount.textContent = `${model.stageNumber} из ${model.stageTotal} этапов`;
  renderCompleted(model);
  renderQueue(model);
  renderSegments(model);
  updateQueueOverflow();
  root.dataset.hubStartupScreen = model.failed ? "failed" : "visible";
  screen.hidden = false;
}

function revealCurrentOperation() {
  requestAnimationFrame(() => {
    queueList.firstElementChild?.scrollIntoView({ block: "nearest" });
  });
}

function showModel(model) {
  const nextOperationId = model.operations[model.currentIndex]?.id ?? "complete";
  const operationChanged = currentOperationId !== nextOperationId;
  if (currentOperationId && operationChanged) {
    screen.classList.add("is-transitioning");
    window.setTimeout(() => {
      applyModel(model);
      revealCurrentOperation();
      screen.classList.remove("is-transitioning");
      screen.classList.add("is-arrived");
      window.setTimeout(() => screen.classList.remove("is-arrived"), 1_150);
    }, 270);
  } else {
    applyModel(model);
    if (operationChanged) revealCurrentOperation();
  }
  currentOperationId = nextOperationId;
}

function hideScreen() {
  screen.hidden = true;
  delete root.dataset.hubStartupScreen;
}

function scheduleRefresh(delayMs) {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(refresh, delayMs);
}

async function refresh() {
  if (stopped) return;
  let delay = ACTIVE_POLL_MS;
  try {
    const response = await fetch("/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`health ${response.status}`);
    const model = createStartupScreenModel(await response.json());
    observedHealth = true;
    consecutiveFailures = 0;
    reconnectStartedAtMs = 0;
    if (!model.available) {
      hideScreen();
      hadStartup = false;
      delay = READY_POLL_MS;
    } else if (model.ready && !hadStartup) {
      hideScreen();
      delay = READY_POLL_MS;
    } else {
      hadStartup = true;
      showModel(model);
      if (model.ready) {
        if (!hideTimer) {
          hideTimer = window.setTimeout(() => {
            hideTimer = 0;
            hideScreen();
            hadStartup = false;
          }, model.failed ? 2_000 : 1_100);
        }
        delay = READY_POLL_MS;
      } else {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
      }
    }
  } catch {
    delay = RETRY_POLL_MS;
    if (observedHealth && ++consecutiveFailures >= RECONNECT_FAILURE_THRESHOLD) {
      reconnectStartedAtMs ||= Date.now();
      window.clearTimeout(hideTimer);
      hideTimer = 0;
      hadStartup = true;
      showModel(createStartupReconnectModel(reconnectStartedAtMs));
    }
  }
  scheduleRefresh(delay);
}

function updateTimer() {
  if (currentModel && !screen.hidden) {
    timer.textContent = formatStartupElapsed(currentModel.startedAtMs);
  }
}

function resizeCanvas() {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawHorizon(now) {
  if (stopped && screen.hidden) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);
  const time = now * 0.00013;
  const baseY = height * 0.9;
  for (let lane = 0; lane < 9; lane += 1) {
    const alpha = 0.058 - lane * 0.004;
    context.beginPath();
    for (let x = -20; x <= width + 20; x += 14) {
      const normalized = x / Math.max(width, 1);
      const wave = Math.sin(normalized * 6.2 + time * (1 + lane * 0.06) + lane * 0.55);
      const swell = Math.sin(normalized * 2.4 - time * 0.8 + lane * 0.2);
      const y = baseY + wave * (11 + lane * 2.6) + swell * 9 + lane * 8;
      if (x === -20) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = `rgba(70, 152, 226, ${Math.max(alpha, 0.012)})`;
    context.lineWidth = 1;
    context.stroke();
  }
  requestAnimationFrame(drawHorizon);
}

const timerInterval = window.setInterval(updateTimer, 1_000);
new ResizeObserver(resizeCanvas).observe(canvas);
new ResizeObserver(updateQueueOverflow).observe(queueSection);
requestAnimationFrame(drawHorizon);
void refresh();

window.addEventListener("pagehide", () => {
  stopped = true;
  window.clearTimeout(hideTimer);
  window.clearTimeout(pollTimer);
  window.clearInterval(timerInterval);
}, { once: true });
}
