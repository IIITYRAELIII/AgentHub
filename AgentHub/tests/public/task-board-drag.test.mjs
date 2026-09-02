import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadInteraction() {
  const source = await readFile(new URL("../../assets/web-app/task-board.js", import.meta.url), "utf8");
  const window = {
    addEventListener() {},
    clearTimeout,
    removeEventListener() {},
    setTimeout,
  };
  vm.runInNewContext(source, {
    document: { querySelector: () => null },
    window,
  });
  return { interaction: window.AgentHubTaskBoardInteraction, view: window.AgentHubTaskBoardView };
}

class ListenerTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener, capture = false) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ listener, capture: Boolean(capture) });
  }

  removeEventListener(type, listener, capture = false) {
    const expectedCapture = Boolean(capture);
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => (
      entry.listener !== listener || entry.capture !== expectedCapture
    )));
  }

  dispatch(type, event = {}) {
    const value = {
      type,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.immediatePropagationStopped = true; },
      ...event,
    };
    for (const { listener } of this.listeners.get(type) ?? []) {
      listener(value);
      if (value.immediatePropagationStopped) break;
    }
    return value;
  }
}

class ClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) { this.values.add(value); }
  contains(value) { return this.values.has(value); }
  remove(value) { this.values.delete(value); }
}

class BoardNode {
  constructor({ taskId = "", movable = false, destination = "", parent = null } = {}) {
    this.dataset = {};
    if (taskId) this.dataset.boardTaskId = taskId;
    if (movable) this.dataset.boardTaskMovable = "true";
    if (destination) this.dataset.boardDestination = destination;
    this.parent = parent;
    this.classList = new ClassList();
    this.captured = [];
    this.released = [];
  }

  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (selector === "[data-board-task-id]" && node.dataset.boardTaskId) return node;
      if (
        selector === '[data-board-task-id][data-board-task-movable="true"]'
        && node.dataset.boardTaskId
        && node.dataset.boardTaskMovable === "true"
      ) return node;
      if (selector === "[data-board-destination]" && node.dataset.boardDestination) return node;
    }
    return null;
  }

  releasePointerCapture(id) { this.released.push(id); }
  setPointerCapture(id) { this.captured.push(id); }
}

function createHarness(interaction) {
  const root = new ListenerTarget();
  const windowTarget = new ListenerTarget();
  windowTarget.setTimeout = setTimeout;
  windowTarget.clearTimeout = clearTimeout;
  const sourceColumn = new BoardNode({ destination: "backlog" });
  const source = new BoardNode({ taskId: "task-1", movable: true, parent: sourceColumn });
  const targetColumn = new BoardNode({ destination: "workspace:one" });
  const target = new BoardNode({ taskId: "task-2", movable: true, parent: targetColumn });
  const columnHandle = new BoardNode({ parent: targetColumn });
  const nodes = new Set([sourceColumn, source, targetColumn, target, columnHandle]);
  let pointTarget = target;
  root.contains = (node) => nodes.has(node);
  root.ownerDocument = { elementFromPoint: () => pointTarget };
  const moves = [];
  const controller = interaction.createPointerDrag({
    root,
    windowTarget,
    onMove: (detail) => moves.push({ ...detail }),
  });
  return {
    controller,
    moves,
    root,
    source,
    sourceColumn,
    target,
    targetColumn,
    windowTarget,
    setPointTarget(node) { pointTarget = node; },
  };
}

function pointerEvent(target, overrides = {}) {
  return {
    target,
    pointerId: 11,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    ...overrides,
  };
}

test("pointer drag reorders a Task once and suppresses only the accidental click", async () => {
  const { interaction } = await loadInteraction();
  const harness = createHarness(interaction);

  harness.root.dispatch("pointerdown", pointerEvent(harness.source, { clientX: 0, clientY: 0 }));
  const moved = harness.root.dispatch("pointermove", pointerEvent(harness.source, { clientX: 20 }));
  assert.equal(moved.defaultPrevented, true);
  assert.deepEqual(harness.source.captured, [11]);
  assert.equal(harness.source.classList.contains("is-pointer-dragging"), true);
  assert.equal(harness.target.classList.contains("is-dragover"), true);

  harness.root.dispatch("pointerup", pointerEvent(harness.source, { clientX: 20, buttons: 0 }));
  assert.deepEqual(harness.moves, [{
    taskId: "task-1",
    destination: "workspace:one",
    beforeId: "task-2",
  }]);
  assert.deepEqual(harness.source.released, [11]);
  assert.equal(harness.source.classList.contains("is-pointer-dragging"), false);
  assert.equal(harness.target.classList.contains("is-dragover"), false);

  const accidentalClick = harness.root.dispatch("click", { target: harness.source });
  assert.equal(accidentalClick.defaultPrevented, true);
  assert.equal(accidentalClick.immediatePropagationStopped, true);
  const intentionalClick = harness.root.dispatch("click", { target: harness.source });
  assert.equal(intentionalClick.defaultPrevented, undefined);
  harness.controller.destroy();
});

test("pointer drag moves to empty column space without a before Task", async () => {
  const { interaction } = await loadInteraction();
  const harness = createHarness(interaction);
  harness.setPointTarget(harness.targetColumn);

  harness.root.dispatch("pointerdown", pointerEvent(harness.source, { clientX: 0, clientY: 0 }));
  harness.root.dispatch("pointermove", pointerEvent(harness.source, { clientX: 20 }));
  harness.root.dispatch("pointerup", pointerEvent(harness.source, { clientX: 20, buttons: 0 }));

  assert.deepEqual(harness.moves, [{
    taskId: "task-1",
    destination: "workspace:one",
    beforeId: null,
  }]);
  harness.controller.destroy();
});

test("pointer drag released over its source does not reorder the Task", async () => {
  const { interaction } = await loadInteraction();
  const harness = createHarness(interaction);
  harness.setPointTarget(harness.source);

  harness.root.dispatch("pointerdown", pointerEvent(harness.source, { clientX: 0, clientY: 0 }));
  harness.root.dispatch("pointermove", pointerEvent(harness.source, { clientX: 20 }));
  harness.root.dispatch("pointerup", pointerEvent(harness.source, { clientX: 20, buttons: 0 }));

  assert.deepEqual(harness.moves, []);
  assert.equal(harness.sourceColumn.classList.contains("is-dragover"), false);
  harness.controller.destroy();
});

test("native Task drag owns the gesture and prevents pointer double-send", async () => {
  const { interaction } = await loadInteraction();
  const harness = createHarness(interaction);

  harness.root.dispatch("pointerdown", pointerEvent(harness.source, { clientX: 0, clientY: 0 }));
  harness.root.dispatch("dragstart", { target: harness.source });
  harness.root.dispatch("pointermove", pointerEvent(harness.source, { clientX: 20 }));
  harness.root.dispatch("pointerup", pointerEvent(harness.source, { clientX: 20, buttons: 0 }));
  harness.root.dispatch("dragend", { target: harness.source });

  assert.deepEqual(harness.moves, []);
  assert.deepEqual(harness.source.captured, []);
  harness.controller.destroy();
});

test("blur clears native arbitration when dragend is missing", async () => {
  const { interaction } = await loadInteraction();
  const harness = createHarness(interaction);

  harness.root.dispatch("pointerdown", pointerEvent(harness.source, { clientX: 0, clientY: 0 }));
  harness.root.dispatch("dragstart", { target: harness.source });
  harness.windowTarget.dispatch("blur");
  harness.root.dispatch("pointerdown", pointerEvent(harness.source, { pointerId: 12, clientX: 0, clientY: 0 }));
  harness.root.dispatch("pointermove", pointerEvent(harness.source, { pointerId: 12, clientX: 20 }));
  harness.root.dispatch("pointerup", pointerEvent(harness.source, {
    pointerId: 12,
    clientX: 20,
    buttons: 0,
  }));

  assert.deepEqual(harness.moves, [{
    taskId: "task-1",
    destination: "workspace:one",
    beforeId: "task-2",
  }]);
  harness.controller.destroy();
});

test("touch and column-handle gestures stay outside Task pointer fallback", async () => {
  const { interaction } = await loadInteraction();
  const harness = createHarness(interaction);

  const touchDown = harness.root.dispatch("pointerdown", pointerEvent(harness.source, {
    pointerType: "touch",
  }));
  const touchMove = harness.root.dispatch("pointermove", pointerEvent(harness.source, {
    pointerType: "touch",
    clientX: 30,
  }));
  harness.root.dispatch("pointerup", pointerEvent(harness.source, { pointerType: "touch" }));
  harness.root.dispatch("pointerdown", pointerEvent(harness.targetColumn, { clientX: 0 }));
  harness.root.dispatch("pointermove", pointerEvent(harness.targetColumn, { clientX: 30 }));
  harness.root.dispatch("pointerup", pointerEvent(harness.targetColumn, { clientX: 30 }));

  assert.equal(touchDown.defaultPrevented, undefined);
  assert.equal(touchMove.defaultPrevented, undefined);
  assert.deepEqual(harness.moves, []);
  harness.controller.destroy();
});

test("cancel, blur, and rerender release capture and clear drag state", async () => {
  const { interaction } = await loadInteraction();
  const harness = createHarness(interaction);
  const begin = (pointerId) => {
    harness.root.dispatch("pointerdown", pointerEvent(harness.source, {
      pointerId,
      clientX: 0,
      clientY: 0,
    }));
    harness.root.dispatch("pointermove", pointerEvent(harness.source, {
      pointerId,
      clientX: 20,
    }));
  };

  begin(11);
  harness.root.dispatch("pointercancel", pointerEvent(harness.source, { pointerId: 11 }));
  begin(12);
  harness.windowTarget.dispatch("blur");
  begin(13);
  harness.controller.cancelForRerender();

  assert.deepEqual(harness.moves, []);
  assert.deepEqual(harness.source.captured, [11, 12, 13]);
  assert.deepEqual(harness.source.released, [11, 12, 13]);
  assert.equal(harness.source.classList.contains("is-pointer-dragging"), false);
  assert.equal(harness.target.classList.contains("is-dragover"), false);
  harness.controller.destroy();
});

test("board rerender restores workspace and per-column scroll positions", async () => {
  const { view } = await loadInteraction();
  const list = (scrollTop) => ({ scrollTop });
  const column = (id, scrollTop) => {
    const columnList = list(scrollTop);
    return {
      dataset: { boardDestination: id },
      querySelector: () => columnList,
      columnList,
    };
  };
  const backlog = column("backlog", 120);
  const workspace = column("workspace:one", 260);
  const notes = column("notes", 80);
  const regions = {
    backlog: { querySelectorAll: () => [backlog] },
    workspaces: { scrollLeft: 480, querySelectorAll: () => [workspace] },
    notes: { querySelectorAll: () => [notes] },
  };

  const snapshot = view.taskBoardScrollSnapshot(regions);
  regions.workspaces.scrollLeft = 0;
  backlog.columnList.scrollTop = 0;
  workspace.columnList.scrollTop = 0;
  notes.columnList.scrollTop = 0;
  view.restoreTaskBoardScroll(regions, snapshot);

  assert.equal(regions.workspaces.scrollLeft, 480);
  assert.equal(backlog.columnList.scrollTop, 120);
  assert.equal(workspace.columnList.scrollTop, 260);
  assert.equal(notes.columnList.scrollTop, 80);
});
