(() => {
  "use strict";

  const STREAM_ORDER_MODES = Object.freeze({
    ACTIVITY: "activity",
    MANUAL: "manual",
  });

  const STREAM_CARD_WIDTH_MODES = Object.freeze({
    AUTO: "auto",
    FIXED: "fixed",
  });

  const STREAM_CARD_MIN_WIDTH = 90;
  const STREAM_CARD_MAX_WIDTH = 450;
  const DEFAULT_ACTIVITY_RECENT_MINUTES = 3 * 60;
  const MAX_ACTIVITY_RECENT_MINUTES = 30 * 24 * 60;
  const ACTIVITY_STREAM_DETAILED_CARDS_KEY = "agent-hub:activity-stream-detailed-cards:v1";
  const STREAM_STATUS_EFFECT_KEY = "agent-hub-stream-status-effect";
  const STREAM_STATUS_STYLE_KEY = "agent-hub-stream-status-style";
  const STREAM_CARD_SETTINGS_CHANGE_EVENT = "agenthub:stream-card-settings-change";
  const STREAM_VIEW_SETTINGS_CHANGE_EVENT = "agenthub:stream-view-settings-change";
  const QUICK_MESSAGE_MAX_SCOPES = 200;
  const QUICK_MESSAGE_MAX_ITEMS = 20;
  const QUICK_MESSAGE_MAX_LABEL = 64;
  const QUICK_MESSAGE_MAX_TEXT = 4_000;

  function normalizePinnedWorkspaceStreams(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const normalized = {};
    for (const [workspaceId, streamIds] of Object.entries(source).slice(0, 100)) {
      const id = String(workspaceId ?? "").trim();
      if (!id || !Array.isArray(streamIds)) continue;
      const pinned = [...new Set(streamIds
        .map((streamId) => String(streamId ?? "").trim())
        .filter(Boolean))]
        .slice(0, 100);
      if (pinned.length) normalized[id] = pinned;
    }
    return normalized;
  }

  function normalizeQuickMessageEntry(value) {
    const source = value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { text: value };
    const text = String(source.text ?? "").trim().slice(0, QUICK_MESSAGE_MAX_TEXT);
    if (!text) return null;
    const label = String(source.label ?? text).trim().slice(0, QUICK_MESSAGE_MAX_LABEL)
      || text.slice(0, QUICK_MESSAGE_MAX_LABEL);
    return {
      id: String(source.id ?? label).trim().slice(0, QUICK_MESSAGE_MAX_LABEL) || label,
      label,
      text,
    };
  }

  function normalizeQuickMessageEntries(value) {
    if (!Array.isArray(value)) return [];
    const entries = [];
    const seen = new Set();
    for (const item of value) {
      const entry = normalizeQuickMessageEntry(item);
      if (!entry || seen.has(entry.text)) continue;
      entries.push(entry);
      seen.add(entry.text);
      if (entries.length >= QUICK_MESSAGE_MAX_ITEMS) break;
    }
    return entries;
  }

  function normalizeQuickMessageScopeMap(value) {
    const normalized = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
    for (const [scopeId, entries] of Object.entries(value).slice(0, QUICK_MESSAGE_MAX_SCOPES)) {
      const id = String(scopeId ?? "").trim();
      if (!id) continue;
      const normalizedEntries = normalizeQuickMessageEntries(entries);
      if (normalizedEntries.length) normalized[id] = normalizedEntries;
    }
    return normalized;
  }

  function normalizeQuickMessages(value) {
    return {
      global: normalizeQuickMessageEntries(value?.global),
      streams: normalizeQuickMessageScopeMap(value?.streams),
      workspaces: normalizeQuickMessageScopeMap(value?.workspaces),
    };
  }

  function quickMessagesForStream(selection, workspaceId, streamId) {
    const messages = normalizeQuickMessages(selection?.quickMessages);
    const globalEntries = messages.global;
    const workspaceEntries = messages.workspaces[String(workspaceId ?? "").trim()] ?? [];
    const streamEntries = messages.streams[String(streamId ?? "").trim()] ?? [];
    const entries = [];
    const seen = new Set();
    for (const [scope, source] of [
      ["global", globalEntries],
      ["workspace", workspaceEntries],
      ["stream", streamEntries],
    ]) {
      for (const entry of source) {
        if (seen.has(entry.text)) continue;
        entries.push({ ...entry, scope });
        seen.add(entry.text);
      }
    }
    return entries;
  }

  function quickMessagesFromText(value) {
    return normalizeQuickMessageEntries(
      String(value ?? "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("|");
          return separator < 0
            ? { label: line, text: line }
            : {
                label: line.slice(0, separator).trim(),
                text: line.slice(separator + 1).trim(),
              };
        }),
    );
  }

  function quickMessagesToText(entries) {
    return normalizeQuickMessageEntries(entries)
      .map((entry) => (entry.label === entry.text ? entry.text : `${entry.label} | ${entry.text}`))
      .join("\n");
  }

  function setQuickMessagesForScope(selection, scope, scopeId, entries) {
    const quickMessages = normalizeQuickMessages(selection?.quickMessages);
    if (scope === "global") {
      quickMessages.global = normalizeQuickMessageEntries(entries);
      return quickMessages;
    }
    const key = scope === "workspace" ? "workspaces" : "streams";
    const id = String(scopeId ?? "").trim();
    if (!id) return quickMessages;
    const normalizedEntries = normalizeQuickMessageEntries(entries);
    if (normalizedEntries.length) quickMessages[key][id] = normalizedEntries;
    else delete quickMessages[key][id];
    return quickMessages;
  }

  function normalizeActivityRecentMinutes(value) {
    const minutes = Math.round(Number(value));
    return Number.isFinite(minutes)
      ? Math.max(0, Math.min(MAX_ACTIVITY_RECENT_MINUTES, minutes))
      : DEFAULT_ACTIVITY_RECENT_MINUTES;
  }

  function normalizeStreamCardSettings(value) {
    const widthMode = value?.streamCardWidthMode ?? value?.widthMode;
    const fixedWidth = value?.streamCardFixedWidth ?? value?.fixedWidth;
    const gapEnabled = value?.streamCardGapEnabled ?? value?.gapEnabled;
    const width = Math.round(Number(fixedWidth));
    return {
      widthMode: widthMode === STREAM_CARD_WIDTH_MODES.FIXED
        ? STREAM_CARD_WIDTH_MODES.FIXED
        : STREAM_CARD_WIDTH_MODES.AUTO,
      fixedWidth: Number.isFinite(width)
        ? Math.min(STREAM_CARD_MAX_WIDTH, Math.max(STREAM_CARD_MIN_WIDTH, width))
        : STREAM_CARD_MIN_WIDTH,
      gapEnabled: gapEnabled === true,
    };
  }

  function streamCardSettingsAvailable({ isWide, surface }) {
    return Boolean(isWide) && surface !== "mobile";
  }

  function streamCardSettingsWrapperNeedsReplacement(currentWrapper, renderedWrapper) {
    return !renderedWrapper || renderedWrapper !== currentWrapper;
  }

  function setTextContentIfChanged(element, value) {
    if (!element) return false;
    const nextValue = String(value);
    if (element.textContent === nextValue) return false;
    element.textContent = nextValue;
    return true;
  }

  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const PHOSPHOR_ICON_PATHS = Object.freeze({
    "caret-down": "M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z",
    "caret-right": "M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z",
    "caret-up": "M213.66,165.66a8,8,0,0,1-11.32,0L128,91.31,53.66,165.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,213.66,165.66Z",
    copy: "M216,32H88A16,16,0,0,0,72,48V72H48A16,16,0,0,0,32,88V216a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V192h24a16,16,0,0,0,16-16V48A16,16,0,0,0,216,32ZM176,216H48V88H72v88a16,16,0,0,0,16,16h88Zm40-40H88V48H216Z",
    "clock-counter-clockwise": "M136,80v43.47l36.12,21.67a8,8,0,0,1-8.24,13.72l-40-24A8,8,0,0,1,120,128V80a8,8,0,0,1,16,0Zm-8-48A95.44,95.44,0,0,0,60.08,60.15C52.81,67.51,46.35,74.59,40,82V64a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H72a8,8,0,0,0,0-16H49c7.15-8.42,14.27-16.35,22.39-24.57a80,80,0,1,1,1.66,114.75,8,8,0,1,0-11,11.64A96,96,0,1,0,128,32Z",
    "arrow-clockwise": "M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16h28.77L194.4,77.33a80,80,0,1,0,1.84,99.28,8,8,0,0,1,12.48,10A96,96,0,1,1,207.5,67.64L224,84.44V56a8,8,0,0,1,16,0Z",
    "arrows-down-up": "M117.66,170.34a8,8,0,0,1,0,11.32l-32,32a8,8,0,0,1-11.32,0l-32-32a8,8,0,0,1,11.32-11.32L72,188.69V48a8,8,0,0,1,16,0V188.69l18.34-18.35A8,8,0,0,1,117.66,170.34Zm96-96-32-32a8,8,0,0,0-11.32,0l-32,32a8,8,0,0,0,11.32,11.32L168,67.31V208a8,8,0,0,0,16,0V67.31l18.34,18.35a8,8,0,0,0,11.32-11.32Z",
    "pencil-simple": "M227.31,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96A16,16,0,0,0,227.31,73.37ZM92.69,208H48V163.31l88-88L180.69,120ZM216,84.69,192,108.69,147.31,64,171.31,40,216,84.69Z",
    plus: "M216,128a8,8,0,0,1-8,8H136v72a8,8,0,0,1-16,0V136H48a8,8,0,0,1,0-16h72V48a8,8,0,0,1,16,0v72h72A8,8,0,0,1,216,128Z",
    "push-pin-simple": "M235.32,73.37,182.63,20.69a16,16,0,0,0-22.63,0L132.69,48,92.69,36.69a16,16,0,0,0-15.38,4.1L52.69,65.37a16,16,0,0,0,0,22.63L92.69,128,40,180.69A16,16,0,0,0,40,203.31L52.69,216a16,16,0,0,0,22.62,0L128,163.31l40,40a16,16,0,0,0,22.63,0l24.68-24.68a16,16,0,0,0,4.1-15.38L208,123.31,235.32,96A16,16,0,0,0,235.32,73.37ZM196.69,112a16,16,0,0,0-4.1,15.38L204,167.31,179.31,192l-40-40a16,16,0,0,0-22.62,0L64,204.69,51.31,192,104,139.31a16,16,0,0,0,0-22.62l-40-40L88.69,52,128.62,63.41a16,16,0,0,0,15.38-4.1L171.31,32,224,84.69Z",
  });

  function createPhosphorIcon(documentRef, name, className = "") {
    if (typeof documentRef?.createElementNS !== "function") {
      throw new TypeError("SVG-capable document is required");
    }
    const pathData = PHOSPHOR_ICON_PATHS[name];
    if (!pathData) throw new Error(`unknown Phosphor icon: ${name}`);
    const svg = documentRef.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("data-phosphor-icon", name);
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    const path = documentRef.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }

  function streamDeckRenderKey(tasks, selectedTaskId) {
    return JSON.stringify({
      selectedTaskId: String(selectedTaskId ?? ""),
      streams: (Array.isArray(tasks) ? tasks : []).map((task) => [
        String(task?.id ?? ""),
        String(task?.workspaceName ?? task?.title ?? ""),
        String(task?.streamName ?? task?.streamDisplayName ?? ""),
      ]),
    });
  }

  function preserveStreamOverflowMenuOpen(previousWorkspaceId, workspaceId, open) {
    const previous = String(previousWorkspaceId ?? "").trim();
    const current = String(workspaceId ?? "").trim();
    return open === true && Boolean(previous) && previous === current;
  }

  function archiveStreamIntent(streamId) {
    const id = String(streamId ?? "").trim();
    if (!id) throw new Error("stream id is required");
    return { type: "stream:archive", detail: { streamId: id } };
  }

  function normalizeStreamOrderMode(value) {
    return value === STREAM_ORDER_MODES.MANUAL
      ? STREAM_ORDER_MODES.MANUAL
      : STREAM_ORDER_MODES.ACTIVITY;
  }

  function streamLastActivity(stream) {
    return Math.max(0, ...(stream?.tasks ?? []).map((task) => (
      Date.parse(task?.lastActivity || 0) || 0
    )));
  }

  function streamsAreDraggable(mode, surface) {
    return normalizeStreamOrderMode(mode) === STREAM_ORDER_MODES.MANUAL
      && surface !== "mobile";
  }

  function attentionStreamCount(tasks) {
    return (tasks ?? []).reduce((count, task) => (
      count + (task?.running || task?.unread ? 1 : 0)
    ), 0);
  }

  function activityStreamSections(tasks) {
    const active = [];
    const recent = [];
    for (const task of tasks ?? []) {
      if (task?.running || task?.unread) active.push(task);
      else recent.push(task);
    }
    return { active, recent };
  }

  function snapshotTaskActivityAtMs(task) {
    return Number(task?.orderingActivityAtMs)
      || Date.parse(task?.lastAnswerAt ?? "")
      || 0;
  }

  function snapshotTaskPreferred(candidate, current) {
    const rank = (task) => task?.selected
      ? 3
      : task?.running && String(task?.run?.turnId ?? "").trim()
        ? 2
        : task?.running
          ? 1
          : 0;
    const candidateRank = rank(candidate);
    const currentRank = rank(current);
    if (candidateRank !== currentRank) return candidateRank > currentRank;
    if (candidateRank > 0) {
      const candidateStartedAt = Date.parse(candidate?.run?.startedAt ?? candidate?.startedAt ?? "") || 0;
      const currentStartedAt = Date.parse(current?.run?.startedAt ?? current?.startedAt ?? "") || 0;
      if (candidateStartedAt !== currentStartedAt) return candidateStartedAt > currentStartedAt;
    }
    const candidatePosition = Number(candidate?.threadPosition) || 0;
    const currentPosition = Number(current?.threadPosition) || 0;
    if (candidatePosition !== currentPosition) return candidatePosition > currentPosition;
    return snapshotTaskActivityAtMs(candidate) > snapshotTaskActivityAtMs(current);
  }

  function representativeSnapshotTasks(tasks) {
    const groups = new Map();
    for (const task of tasks ?? []) {
      const streamId = String(task?.streamId ?? "").trim();
      const key = streamId || `${String(task?.provider ?? "").trim()}:${String(task?.threadId ?? "").trim()}`;
      const current = groups.get(key);
      const maxActivityAtMs = Math.max(
        current?.maxActivityAtMs ?? 0,
        snapshotTaskActivityAtMs(task),
      );
      groups.set(key, {
        representative: !current || snapshotTaskPreferred(task, current.representative)
          ? task
          : current.representative,
        maxActivityAtMs,
      });
    }
    return [...groups.values()].map(({ representative, maxActivityAtMs }) => (
      maxActivityAtMs > snapshotTaskActivityAtMs(representative)
        ? { ...representative, orderingActivityAtMs: maxActivityAtMs }
        : representative
    ));
  }

  function normalizedContextPercent(value) {
    if (value === null || value === undefined || value === "") return null;
    const percent = Number(value);
    return Number.isFinite(percent) ? Math.round(Math.max(0, Math.min(100, percent))) : null;
  }

  function streamHeadTasks(tasks) {
    const heads = new Map();
    for (const task of tasks ?? []) {
      const streamId = String(task?.streamId ?? "").trim();
      if (!streamId) continue;
      const current = heads.get(streamId);
      const position = Number(task?.threadPosition) || 0;
      const currentPosition = Number(current?.threadPosition) || 0;
      if (!current || position > currentPosition) heads.set(streamId, task);
    }
    return heads;
  }

  function latestRotatedStreamSource(tasks, streamId, targetThreadId) {
    return [...(tasks ?? [])]
      .filter((task) => (
        String(task?.streamId ?? "").trim() === streamId
        && String(task?.threadId ?? "").trim() !== targetThreadId
        && task?.context?.compaction?.rotated === true
      ))
      .sort((left, right) => (
        (Date.parse(right?.context?.compaction?.completedAt ?? "") || 0)
          - (Date.parse(left?.context?.compaction?.completedAt ?? "") || 0)
        || (Number(right?.threadPosition) || 0) - (Number(left?.threadPosition) || 0)
      ))[0] ?? null;
  }

  function streamRotationTransitions(previousTasks, tasks) {
    const previousByStream = streamHeadTasks(previousTasks);
    const currentByStream = streamHeadTasks(tasks);
    const availableTasks = [...(tasks ?? []), ...(previousTasks ?? [])];
    const transitions = [];
    for (const [streamId, task] of currentByStream) {
      const previous = previousByStream.get(streamId) ?? null;
      if (!previous || String(previous.threadId) === String(task.threadId)) continue;
      const source = latestRotatedStreamSource(availableTasks, streamId, String(task.threadId));
      const previousRotationActive = (previousTasks ?? []).some((candidate) => (
        String(candidate?.streamId ?? "").trim() === streamId
        && ["manual-rotation", "automatic-rotation"].includes(String(candidate?.maintenance?.reason ?? ""))
      ));
      const sourceWasJustRotated = source && !(previousTasks ?? []).some((candidate) => (
        String(candidate?.streamId ?? "").trim() === streamId
        && String(candidate?.threadId ?? "").trim() === String(source.threadId ?? "").trim()
        && candidate?.context?.compaction?.rotated === true
      ));
      if (!previousRotationActive && !sourceWasJustRotated) continue;
      const sourceCompaction = source?.context?.compaction ?? null;
      transitions.push({
        streamId,
        task,
        sourceThreadId: source?.threadId ?? previous.threadId,
        beforePercent: normalizedContextPercent(sourceCompaction?.afterPercent)
          ?? normalizedContextPercent(source?.context?.percent)
          ?? normalizedContextPercent(previous?.context?.percent),
        time: sourceCompaction?.completedAt ?? new Date().toISOString(),
      });
    }
    return transitions;
  }

  function rotationMaintenancePresentation(beforeValue, afterValue) {
    const beforePercent = normalizedContextPercent(beforeValue);
    const afterPercent = normalizedContextPercent(afterValue);
    if (beforePercent !== null && afterPercent !== null) {
      return {
        maintenanceLabel: "Ротация завершена",
        maintenanceDetail: `Новый Thread ${afterPercent}%; источник ${beforePercent}%`,
        text: `Ротация завершена: новый Thread ${afterPercent}% (источник ${beforePercent}%)`,
      };
    }
    if (beforePercent !== null) {
      return {
        maintenanceLabel: "Ротация завершена",
        maintenanceDetail: `${beforePercent}% → замер нового Thread выполняется`,
        text: `Ротация завершена; новый Thread создан после ${beforePercent}%`,
      };
    }
    return {
      maintenanceLabel: "Ротация завершена",
      maintenanceDetail: afterPercent === null ? "Новый Thread создан" : `Новый Thread: ${afterPercent}%`,
      text: afterPercent === null
        ? "Ротация завершена; новый Thread создан"
        : `Ротация завершена; новый Thread ${afterPercent}%`,
    };
  }

  function taskListSections(tasks) {
    const workspaceTasks = [];
    const unassignedTasks = [];
    for (const task of tasks ?? []) {
      if (String(task?.workspaceId ?? "").trim()) workspaceTasks.push(task);
      else unassignedTasks.push(task);
    }
    return { workspaceTasks, unassignedTasks };
  }

  function streamStatusPresentation(task) {
    const running = Boolean(task?.running);
    const answerReady = Boolean(task?.unread);
    const statusLabel = [
      running ? "Ход выполняется" : "",
      answerReady ? "Ответ готов" : "",
    ].filter(Boolean).join(" · ") || String(task?.statusLabel ?? "");
    return { running, answerReady, statusLabel };
  }

  function isExactActiveUserTurn(task) {
    if (task?.running !== true) return false;
    const run = task?.run;
    const turnId = String(run?.turnId ?? "").trim();
    if (
      !turnId
      || String(run?.operationKind ?? "").trim() !== "user-turn"
      || String(run?.projectionState ?? "").trim() !== "active"
    ) return false;
    const final = task?.latestFinal;
    if (!final) return true;
    return !(
      String(final.provider ?? "").trim().toLowerCase()
        === String(task.provider ?? "").trim().toLowerCase()
      && String(final.threadId ?? "").trim() === String(task.threadId ?? "").trim()
      && String(final.turnId ?? "").trim() === turnId
    );
  }

  function answerArrivalTaskIds(tasks, observedFinalIdentityByTaskId) {
    const observedFinals = observedFinalIdentityByTaskId
      && typeof observedFinalIdentityByTaskId.has === "function"
      && typeof observedFinalIdentityByTaskId.get === "function"
      && typeof observedFinalIdentityByTaskId.set === "function"
      ? observedFinalIdentityByTaskId
      : new Map();
    const finalIdentity = (task) => {
      const final = task?.latestFinal;
      const provider = String(final?.provider ?? "").trim().toLowerCase();
      const threadId = String(final?.threadId ?? "").trim();
      const turnId = String(final?.turnId ?? "").trim();
      const revision = Number(final?.revision);
      return provider && threadId && turnId && Number.isSafeInteger(revision) && revision > 0
        ? `${provider}\0${threadId}\0${turnId}\0${revision}`
        : "";
    };
    const arrivals = new Set();
    for (const task of tasks ?? []) {
      const id = String(task?.id ?? "");
      if (!id) continue;
      const currentFinal = finalIdentity(task);
      if (!observedFinals.has(id)) {
        observedFinals.set(id, currentFinal);
        continue;
      }
      if (!currentFinal) continue;
      const observedFinal = observedFinals.get(id);
      if (currentFinal === observedFinal) continue;
      observedFinals.set(id, currentFinal);
      if (task?.unread === true) arrivals.add(id);
    }
    return arrivals;
  }

  function streamStatusState(task) {
    const failed = Boolean(task?.failed || task?.error)
      || /(?:fail|error|сбой|ошиб)/iu.test(`${String(task?.status ?? "")} ${String(task?.statusLabel ?? "")}`);
    if (failed) return "failed";
    return task?.running ? "running" : "idle";
  }

  function compactStreamActivityValue(value) {
    const source = String(value ?? "").trim();
    if (source === "только что") return "<1м";
    const compact = source.replace(/\s*\d+\s*с$/u, "").trim();
    return compact !== source ? compact || "<1м" : source;
  }

  function normalizeImmediateTimeLabels(container) {
    container?.querySelectorAll?.(".task-workspace-time, .task-time").forEach((label) => {
      if (label.textContent.trim() === "только что") label.textContent = "<1м";
    });
  }

  function resolveStableStreamCardWidth(widths, streamId, measuredWidth = 0) {
    const key = String(streamId ?? "").trim();
    if (!key) return 0;
    const cached = Number(widths.get(key)) || 0;
    if (cached > 0) return cached;
    const width = Number(measuredWidth) || 0;
    if (width > 0) widths.set(key, width);
    return width;
  }

  function calculateOverflowShift(overflowLeft, lastVisibleRight, currentShift = 0) {
    return Math.max(0, Number(overflowLeft) + Number(currentShift) - Number(lastVisibleRight));
  }

  function includeTaskInActivityRail(task, kind) {
    const workspaceName = String(task?.workspaceName ?? "").trim();
    return workspaceName !== "Other" || kind === "running" || kind === "completed";
  }

  function resolveTaskHierarchy(task, workspaces) {
    const workspaceId = String(task?.workspaceId ?? "").trim();
    const streamId = String(task?.streamId ?? "").trim();
    const provider = String(task?.provider ?? "");
    const threadId = String(task?.threadId ?? "");
    const matches = [];
    for (const candidate of workspaces ?? []) {
      for (const stream of candidate?.streams ?? []) {
        const streamMatches = streamId
          ? String(stream?.id ?? "") === streamId
          : (provider && threadId && (stream.threads ?? []).some((thread) => (
            String(thread?.provider ?? "") === provider
            && String(thread?.threadId ?? thread?.id ?? "") === threadId
          )));
        if (streamMatches || (workspaceId && String(candidate?.id ?? "") === workspaceId)) {
          matches.push({ workspace: candidate, stream: streamMatches ? stream : null });
        }
      }
      if (workspaceId && !(candidate?.streams ?? []).length && String(candidate?.id ?? "") === workspaceId) {
        matches.push({ workspace: candidate, stream: null });
      }
    }
    if (!matches.length) return { workspace: null, stream: null };
    const exact = matches.find((match) => match.stream) ?? matches[0];
    if (!streamId && !workspaceId && matches.length !== 1) return { workspace: null, stream: null };
    return exact;
  }

  function workspaceGroupLastActivity(group) {
    return Math.max(0, ...(group?.tasks ?? []).map((task) => (
      Date.parse(task?.lastActivity || 0) || 0
    )));
  }

  function orderWorkspaceGroups(groups) {
    return [...(groups ?? [])].sort((left, right) => (
      Number(left?.kind === "system") - Number(right?.kind === "system")
      || workspaceGroupLastActivity(right) - workspaceGroupLastActivity(left)
      || String(left?.name ?? "").localeCompare(String(right?.name ?? ""), "ru")
      || String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
    ));
  }

  /* Список рабочих пространств отвечает сразу на два разных вопроса: «где
     сейчас идёт работа» и «где вообще живёт проект». Пока это один список,
     они мешают друг другу: сортировка по активности поднимает наверх целое
     семейство однотипных пространств, а группировка по семействам, наоборот,
     прячет то, что горит прямо сейчас.

     Поэтому вопросы разведены. Сверху — короткая лента активных, плоская и
     без группировки: семейство попадает в неё ровно теми пространствами, где
     действительно идёт работа. Ниже — каталог, который от активности не
     зависит: порядок в нём стабильный, и место проекта не прыгает от того,
     что кто-то в соседнем потоке написал сообщение.

     Семейство определяется по первому слову имени и собирается только когда
     его носят minGroupSize и больше пространств: две «FB» группой не станут. */
  const WORKSPACE_ACTIVE_LIMIT = 6;
  const WORKSPACE_ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000;
  const WORKSPACE_GROUP_MIN_SIZE = 3;

  function workspaceFamilyKey(group) {
    const name = String(group?.name ?? "").trim();
    const [head] = name.split(/\s+/u);
    return head && head.length <= 24 && name.length > head.length ? head : "";
  }

  function workspaceSections(groups, {
    nowMs = Date.now(),
    activeLimit = WORKSPACE_ACTIVE_LIMIT,
    activeWindowMs = WORKSPACE_ACTIVE_WINDOW_MS,
    minGroupSize = WORKSPACE_GROUP_MIN_SIZE,
  } = {}) {
    const ordered = orderWorkspaceGroups(groups);
    const active = [];
    const rest = [];
    for (const group of ordered) {
      const running = (group?.tasks ?? []).some((task) => task?.running);
      const fresh = nowMs - workspaceGroupLastActivity(group) <= activeWindowMs;
      if ((running || fresh) && active.length < activeLimit) active.push(group);
      else rest.push(group);
    }

    const families = new Map();
    for (const group of rest) {
      const key = workspaceFamilyKey(group);
      if (!key) continue;
      families.set(key, (families.get(key) ?? 0) + 1);
    }

    const catalog = [];
    const opened = new Map();
    for (const group of [...rest].sort((left, right) => (
      String(left?.name ?? "").localeCompare(String(right?.name ?? ""), "ru")
    ))) {
      const key = workspaceFamilyKey(group);
      if (!key || (families.get(key) ?? 0) < minGroupSize) {
        catalog.push({ type: "workspace", group });
        continue;
      }
      let family = opened.get(key);
      if (!family) {
        family = { type: "family", name: key, items: [] };
        opened.set(key, family);
        catalog.push(family);
      }
      family.items.push({
        ...group,
        shortName: String(group.name ?? "").slice(key.length).trim() || group.name,
      });
    }
    return { active, catalog };
  }

  function orderWorkspaceStreams(streams, mode, pinnedIds = []) {
    const uniqueStreams = [];
    const available = new Map();
    for (const stream of streams ?? []) {
      const id = String(stream?.id ?? "").trim();
      if (!id || available.has(id)) continue;
      available.set(id, stream);
      uniqueStreams.push(stream);
    }

    const pinned = new Set((pinnedIds ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean));
    const pinnedFirst = (left, right) => (
      Number(pinned.has(String(right?.id ?? ""))) - Number(pinned.has(String(left?.id ?? "")))
    );

    if (normalizeStreamOrderMode(mode) === STREAM_ORDER_MODES.ACTIVITY) {
      return uniqueStreams.sort((left, right) => (
        pinnedFirst(left, right)
        || streamLastActivity(right) - streamLastActivity(left)
        || (Number(right?.ordinal) || 0) - (Number(left?.ordinal) || 0)
      ));
    }

    const ordered = uniqueStreams.sort((left, right) => (
      pinnedFirst(left, right)
      || (Number(left?.ordinal) || 0) - (Number(right?.ordinal) || 0)
      || String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
    ));
    const dashBotIndex = ordered.findIndex((stream) => (
      stream?.name === "DashBot" && !pinned.has(String(stream?.id ?? ""))
    ));
    if (dashBotIndex > 0) {
      const firstUnpinnedIndex = ordered.findIndex((stream) => !pinned.has(String(stream?.id ?? "")));
      const [dashBot] = ordered.splice(dashBotIndex, 1);
      ordered.splice(Math.max(0, firstUnpinnedIndex), 0, dashBot);
    }
    return ordered;
  }

  function pinnedWorkspaceStreamIds(selection, workspaceId) {
    const id = String(workspaceId ?? "").trim();
    if (!id) return [];
    return normalizePinnedWorkspaceStreams(selection?.pinnedWorkspaceStreams)[id] ?? [];
  }

  function streamIsPinned(selection, workspaceId, streamId) {
    return pinnedWorkspaceStreamIds(selection, workspaceId).includes(String(streamId ?? "").trim());
  }

  function togglePinnedWorkspaceStream(selection, workspaceId, streamId) {
    const id = String(workspaceId ?? "").trim();
    const target = String(streamId ?? "").trim();
    const pinned = normalizePinnedWorkspaceStreams(selection?.pinnedWorkspaceStreams);
    if (!id || !target) return pinned;
    const current = pinned[id] ?? [];
    if (current.includes(target)) {
      const next = current.filter((value) => value !== target);
      if (next.length) pinned[id] = next;
      else delete pinned[id];
      return pinned;
    }
    pinned[id] = [...current, target].slice(-100);
    return pinned;
  }

  function pinnedStreamActionLabel(pinned) {
    return pinned ? "Открепить Stream" : "Закрепить Stream";
  }

  function pinnedStreamActionTitle(pinned) {
    return pinned
      ? "Вернуть Stream в обычный порядок вкладок"
      : "Показывать Stream первым во вкладках этого Workspace";
  }

  function reconcileOpenStreamIds(previousIds, availableIds, fallbackId, limit = 4) {
    const available = new Set((availableIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean));
    const normalized = [];
    for (const value of previousIds ?? []) {
      const id = String(value ?? "").trim();
      if (!available.has(id) || normalized.includes(id)) continue;
      normalized.push(id);
      if (normalized.length >= limit) break;
    }
    if (normalized.length) return normalized;
    const fallback = String(fallbackId ?? "").trim();
    if (available.has(fallback)) return [fallback];
    const first = available.values().next().value;
    return first ? [first] : [];
  }

  function applyOpenStreamSelection(openIds, streamId, { additive = false, limit = 4 } = {}) {
    const target = String(streamId ?? "").trim();
    const current = [...new Set((openIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))]
      .slice(0, limit);
    if (!target) return { ids: current, limitReached: false };
    if (!additive) {
      return {
        ids: current.includes(target) && current.length > 1 ? current : [target],
        limitReached: false,
      };
    }
    if (current.includes(target)) {
      return {
        ids: current.length > 1 ? current.filter((id) => id !== target) : current,
        limitReached: false,
      };
    }
    if (current.length >= limit) return { ids: current, limitReached: true };
    return { ids: [...current, target], limitReached: false };
  }

  class HorizontalPointerScroller {
    constructor(target, options = {}) {
      if (!target) throw new TypeError("target is required");
      this.target = target;
      this.enabled = typeof options.enabled === "function" ? options.enabled : () => true;
      this.onDragStart = typeof options.onDragStart === "function" ? options.onDragStart : () => {};
      this.onDragEnd = typeof options.onDragEnd === "function" ? options.onDragEnd : () => {};
      this.threshold = Math.max(1, Number(options.thresholdPx) || 5);
      this.pointer = null;
      this.listeners = [];
      this.bind("pointerdown", (event) => this.start(event));
      this.bind("pointermove", (event) => this.move(event));
      this.bind("pointerup", (event) => this.finish(event));
      this.bind("pointercancel", (event) => this.finish(event));
    }

    bind(type, listener) {
      this.target.addEventListener(type, listener);
      this.listeners.push({ type, listener });
    }

    start(event) {
      if (!this.enabled() || event?.isPrimary === false || event?.pointerType === "touch") return;
      if (Number(event?.button ?? 0) !== 0) return;
      this.pointer = {
        id: event.pointerId,
        x: Number(event.clientX) || 0,
        scrollLeft: Number(this.target.scrollLeft) || 0,
        moved: false,
      };
    }

    move(event) {
      const pointer = this.pointer;
      if (!pointer || event.pointerId !== pointer.id) return;
      const delta = (Number(event.clientX) || 0) - pointer.x;
      if (!pointer.moved && Math.abs(delta) < this.threshold) return;
      if (!pointer.moved) {
        pointer.moved = true;
        this.target.setPointerCapture?.(pointer.id);
        this.target.toggleAttribute?.("data-scroll-drag", true);
        this.onDragStart();
      }
      this.target.scrollLeft = pointer.scrollLeft - delta;
      event.preventDefault?.();
    }

    finish(event) {
      const pointer = this.pointer;
      if (!pointer || event.pointerId !== pointer.id) return;
      this.pointer = null;
      if (!pointer.moved) return;
      this.target.releasePointerCapture?.(pointer.id);
      this.target.toggleAttribute?.("data-scroll-drag", false);
      this.onDragEnd({ moved: true });
    }

    destroy() {
      this.pointer = null;
      this.target.toggleAttribute?.("data-scroll-drag", false);
      for (const { type, listener } of this.listeners) {
        this.target.removeEventListener(type, listener);
      }
      this.listeners = [];
    }
  }

  class StreamCardSettingsController {
    constructor(documentRef, windowRef) {
      this.document = documentRef;
      this.window = windowRef;
      this.root = documentRef.documentElement;
      this.tabs = documentRef.querySelector("[data-stream-tabs]");
      this.legacyRecentHours = documentRef.querySelector("[data-activity-recent-hours]");
      this.themeLabPreview = new this.window.URLSearchParams(this.window.location.search).has("theme-lab");
      this.widthMode = STREAM_CARD_WIDTH_MODES.AUTO;
      this.fixedWidth = STREAM_CARD_MIN_WIDTH;
      this.gapEnabled = false;
      this.activityRecentMinutes = DEFAULT_ACTIVITY_RECENT_MINUTES;
      this.open = false;
      this.frame = 0;
      this.autoWidths = new Map();
      this.wrapper = null;
      this.tabsObserver = null;
      this.rootObserver = null;
      this.timeLabelObservers = [];
      this.document.querySelector("[data-focus-toggle]")?.remove();
      this.document.querySelector(".activity-recent-settings")?.remove();
      this.root.removeAttribute("data-focus-mode");
      if (this.themeLabPreview) this.installDialogSettingsClose();
      if (this.themeLabPreview) this.installImmediateTimeLabels();
      if (this.themeLabPreview) {
        try {
          if (this.window.localStorage.getItem(ACTIVITY_STREAM_DETAILED_CARDS_KEY) === "true") {
            this.root.dataset.activityStreamCards = "detailed";
          } else {
            delete this.root.dataset.activityStreamCards;
          }
        } catch {
          delete this.root.dataset.activityStreamCards;
        }
      }
      if (!this.tabs) return;
      this.onDocumentClick = (event) => {
        const wrapper = this.tabs.querySelector("[data-stream-card-settings]");
        if (wrapper && !wrapper.contains(event.target)) this.close(wrapper);
      };
      this.onDocumentKeydown = (event) => {
        if (event.key === "Escape") this.close(this.tabs.querySelector("[data-stream-card-settings]"));
      };
      this.document.addEventListener("click", this.onDocumentClick);
      this.document.addEventListener("keydown", this.onDocumentKeydown);
      this.window.addEventListener("resize", (event) => {
        if (event.isTrusted) this.autoWidths.clear();
        this.schedule();
      });
      if (typeof this.window.MutationObserver === "function") {
        this.tabsObserver = new this.window.MutationObserver((mutations) => {
          const overflowChanged = mutations.some((mutation) => mutation.type === "attributes"
            && mutation.attributeName === "hidden"
            && mutation.target.matches?.(".stream-tab-group, .stream-tabs-overflow"));
          const contentChanged = mutations.some((mutation) => mutation.type !== "attributes"
            || mutation.attributeName === "data-order-mode");
          if (contentChanged) this.sync();
          else if (overflowChanged) this.alignOverflow();
        });
        this.tabsObserver.observe(this.tabs, {
          attributes: true,
          attributeFilter: ["data-order-mode", "hidden"],
          characterData: true,
          childList: true,
          subtree: true,
        });
        this.rootObserver = new this.window.MutationObserver(() => this.schedule());
        this.rootObserver.observe(this.root, {
          attributes: true,
          attributeFilter: [
            "data-activity-stream-cards",
            "data-activity-tasks-auto-separate",
            "data-activity-tasks-always-separate",
            "data-stream-status-effect",
            "data-stream-status-style",
            "data-surface",
            "data-theme",
          ],
        });
      }
      this.schedule();
    }

    installDialogSettingsClose() {
      const head = this.document.querySelector(".dialog-settings-head");
      if (!head || head.querySelector("[data-dialog-settings-close]")) return;
      const button = this.document.createElement("button");
      button.type = "button";
      button.className = "icon-button dialog-settings-close";
      button.dataset.action = "task-settings";
      button.dataset.dialogSettingsClose = "";
      button.title = "Закрыть настройки диалога";
      button.setAttribute("aria-label", "Закрыть настройки диалога");
      button.innerHTML = `
        <svg data-phosphor-icon="x" viewBox="0 0 256 256" aria-hidden="true">
          <line x1="200" y1="56" x2="56" y2="200" fill="none" stroke="currentColor"
            stroke-linecap="round" stroke-linejoin="round" stroke-width="16"></line>
          <line x1="200" y1="200" x2="56" y2="56" fill="none" stroke="currentColor"
            stroke-linecap="round" stroke-linejoin="round" stroke-width="16"></line>
        </svg>`;
      head.append(button);
    }

    installImmediateTimeLabels() {
      for (const selector of [
        "[data-task-list]",
        "[data-stream-tabs]",
        "[data-activity-stream-list]",
        "[data-activity-recent-list]",
      ]) {
        const container = this.document.querySelector(selector);
        if (!container) continue;
        normalizeImmediateTimeLabels(container);
        if (typeof this.window.MutationObserver !== "function") continue;
        const observer = new this.window.MutationObserver(() => normalizeImmediateTimeLabels(container));
        observer.observe(container, { childList: true, characterData: true, subtree: true });
        this.timeLabelObservers.push(observer);
      }
    }

    isActive() {
      const wide = typeof this.window.matchMedia !== "function"
        || this.window.matchMedia("(min-width: 860px)").matches;
      return streamCardSettingsAvailable({
        isWide: wide,
        surface: this.root.dataset.surface,
      });
    }

    schedule() {
      if (this.frame) return;
      this.frame = this.window.requestAnimationFrame(() => {
        this.frame = 0;
        this.sync();
      });
    }

    sync() {
      const orderToggle = this.tabs.querySelector(".stream-order-toggle");
      if (!this.isActive()) {
        this.root.removeAttribute("data-stream-card-settings");
        this.tabs.querySelector("[data-stream-card-settings]")?.remove();
        if (orderToggle) orderToggle.hidden = false;
        this.wrapper = null;
        this.tabs.removeAttribute("data-stream-card-width-mode");
        this.tabs.removeAttribute("data-stream-card-gap-mode");
        this.tabs.style.removeProperty("--stream-card-width");
        this.tabs.style.removeProperty("--stream-overflow-shift");
        return;
      }
      const overflow = this.tabs.querySelector(".stream-tabs-overflow");
      if (!overflow || !orderToggle) return;
      this.root.dataset.streamCardSettings = "true";
      orderToggle.hidden = true;
      let wrapper = this.tabs.querySelector("[data-stream-card-settings]");
      if (streamCardSettingsWrapperNeedsReplacement(this.wrapper, wrapper)) {
        wrapper?.remove();
        wrapper = this.createWrapper(overflow, orderToggle);
        this.wrapper = wrapper;
      }
      this.update(wrapper);
      this.alignOverflow();
    }

    createWrapper(overflow, orderToggle) {
      const wrapper = this.document.createElement("span");
      wrapper.className = "stream-card-settings";
      wrapper.dataset.streamCardSettings = "true";
      wrapper.innerHTML = `
        <button type="button" class="stream-card-settings-toggle" data-stream-card-settings-toggle
          aria-label="Настройки Streams" aria-expanded="false" title="Настройки Streams"></button>
        <div class="stream-card-settings-menu" data-stream-card-settings-menu role="dialog"
          aria-label="Настройки Streams" hidden>
          <section class="stream-card-settings-group" aria-labelledby="stream-settings-status-title">
            <h3 class="stream-card-settings-group-title" id="stream-settings-status-title">Потоки</h3>
            <div class="stream-card-settings-section stream-card-settings-inline-section">
              <span class="stream-card-settings-kicker">Эффект</span>
              <select data-stream-status-effect-select
                aria-label="Эффект активности и готового ответа Stream">
                <option value="calm">Спокойный</option>
                <option value="impulse">Импульс</option>
                <option value="scanner">Сканер</option>
                <option value="energy">Энергия</option>
                <option value="breath">Дыхание</option>
                <option value="thread">Нить</option>
                <option value="sediment">Осадок</option>
                <option value="echo">Эхо</option>
                <option value="off">Выключено</option>
              </select>
            </div>
            <div class="stream-card-settings-section stream-card-settings-gap-section"
              title="Использовать всю поверхность панели вместо одной границы.">
              <span class="stream-card-settings-kicker">Подсвечивать целиком</span>
              <button type="button" class="stream-card-gap-toggle stream-card-settings-switch"
                role="switch" aria-checked="false" aria-label="Подсвечивать панели Stream целиком"
                data-stream-status-fill-toggle>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </section>
          <section class="stream-card-settings-group" aria-labelledby="stream-settings-top-title">
            <h3 class="stream-card-settings-group-title" id="stream-settings-top-title">Верхняя панель</h3>
            <div class="stream-card-settings-section stream-card-settings-inline-section">
              <span class="stream-card-settings-kicker">Порядок</span>
              <span class="stream-card-settings-segmented" role="group" aria-label="Порядок потоков">
                <button type="button" data-stream-order-mode="activity" title="По последней активности">Авто</button>
                <button type="button" data-stream-order-mode="manual">Фикс</button>
              </span>
            </div>
            <div class="stream-card-settings-section stream-card-settings-inline-section">
              <span class="stream-card-settings-kicker">Ширина</span>
              <span class="stream-card-settings-segmented" role="group" aria-label="Режим ширины карточек потоков">
                <button type="button" data-stream-width-mode="auto" aria-pressed="true">Авто</button>
                <button type="button" data-stream-width-mode="fixed" aria-pressed="false">Фикс</button>
              </span>
              <label class="stream-card-settings-range" data-stream-card-range hidden>
                <span><span data-stream-card-width-value>${this.fixedWidth}</span> px</span>
                <input type="range" min="${STREAM_CARD_MIN_WIDTH}" max="${STREAM_CARD_MAX_WIDTH}" step="1"
                  value="${this.fixedWidth}" data-stream-card-width aria-label="Ширина карточек потоков">
                <small>${STREAM_CARD_MIN_WIDTH} — ${STREAM_CARD_MAX_WIDTH} px</small>
              </label>
            </div>
            <div class="stream-card-settings-section stream-card-settings-gap-section">
              <span class="stream-card-settings-kicker">Отступ</span>
              <button type="button" class="stream-card-gap-toggle" role="switch" aria-checked="false"
                aria-label="Отступ между карточками потоков" data-stream-gap-toggle>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </section>
          <section class="stream-card-settings-group" aria-labelledby="stream-settings-right-title">
            <h3 class="stream-card-settings-group-title" id="stream-settings-right-title">Правая панель</h3>
            <div class="stream-card-settings-section stream-card-settings-recent-section">
              <span class="stream-card-settings-kicker">Показывать недавние за</span>
              <span class="stream-card-settings-duration">
                <label>
                  <input type="number" min="0" max="720" step="0.5" inputmode="decimal"
                    data-stream-recent-hours aria-label="Часы для недавних Streams">
                  <span>ч</span>
                </label>
              </span>
            </div>
            <div class="stream-card-settings-section stream-card-settings-gap-section"
              title="Показывать агента, модель и среду в правой панели.">
              <span class="stream-card-settings-kicker">Подробные карточки</span>
              <button type="button" class="stream-card-gap-toggle stream-card-settings-switch"
                role="switch" aria-checked="false" aria-label="Подробные карточки Streams"
                data-stream-detailed-toggle>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
            <div class="stream-card-settings-section stream-card-settings-gap-section"
              title="Когда в одну колонку не помещаются и потоки и задачи">
              <span class="stream-card-settings-kicker">Переносить задачи в отдельную колонку</span>
              <button type="button" class="stream-card-gap-toggle stream-card-settings-switch"
                role="switch" aria-checked="true" aria-label="Переносить задачи в отдельную колонку"
                data-activity-task-separate-toggle>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
            <div class="stream-card-settings-section stream-card-settings-gap-section"
              title="Всегда показывать задачи и потоки в двух колонках"
              data-activity-task-always-separate-setting hidden>
              <span class="stream-card-settings-kicker">Задачи всегда в отдельной колонке</span>
              <button type="button" class="stream-card-gap-toggle stream-card-settings-switch"
                role="switch" aria-checked="false" aria-label="Задачи всегда в отдельной колонке"
                data-activity-task-always-separate-toggle>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </section>
        </div>`;
      const sourceIcon = this.document.querySelector(".view-settings svg");
      if (sourceIcon) {
        const icon = sourceIcon.cloneNode(true);
        icon.classList.add("stream-card-settings-icon");
        wrapper.querySelector("[data-stream-card-settings-toggle]").append(icon);
      }
      overflow.after(wrapper);
      const settingsButton = wrapper.querySelector("[data-stream-card-settings-toggle]");
      const settingsMenu = wrapper.querySelector("[data-stream-card-settings-menu]");
      settingsMenu.hidden = !this.open;
      settingsButton.setAttribute("aria-expanded", String(this.open));
      settingsButton.addEventListener("click", () => {
        this.open = settingsMenu.hidden;
        settingsMenu.hidden = !this.open;
        settingsButton.setAttribute("aria-expanded", String(this.open));
        if (this.open) this.update(wrapper);
      });
      wrapper.querySelectorAll("[data-stream-order-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.dataset.streamOrderMode !== this.orderMode()) orderToggle.click();
          this.window.setTimeout(() => this.schedule(), 0);
        });
      });
      wrapper.querySelectorAll("[data-stream-width-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          const nextMode = button.dataset.streamWidthMode === STREAM_CARD_WIDTH_MODES.FIXED
            ? STREAM_CARD_WIDTH_MODES.FIXED
            : STREAM_CARD_WIDTH_MODES.AUTO;
          if (nextMode !== this.widthMode && nextMode === STREAM_CARD_WIDTH_MODES.AUTO) {
            this.autoWidths.clear();
          }
          this.widthMode = nextMode;
          this.emitSetting("streamCardWidthMode", this.widthMode);
          this.update(wrapper);
          this.refreshOverflow();
        });
      });
      wrapper.querySelector("[data-stream-gap-toggle]").addEventListener("click", () => {
        this.gapEnabled = !this.gapEnabled;
        this.emitSetting("streamCardGapEnabled", this.gapEnabled);
        this.update(wrapper);
        this.refreshOverflow();
      });
      const updateRecentPeriod = () => {
        const rawHours = Math.max(0, Number(wrapper.querySelector("[data-stream-recent-hours]")?.value) || 0);
        const hours = Math.round(rawHours * 2) / 2;
        this.activityRecentMinutes = normalizeActivityRecentMinutes(hours * 60);
        if (this.themeLabPreview && this.legacyRecentHours) {
          this.legacyRecentHours.value = String(hours);
          this.legacyRecentHours.dispatchEvent(new this.window.Event("change", { bubbles: true }));
        }
        this.emitSetting("activityRecentMinutes", this.activityRecentMinutes);
        this.update(wrapper);
      };
      wrapper.querySelector("[data-stream-recent-hours]").addEventListener("change", updateRecentPeriod);
      wrapper.querySelector("[data-stream-detailed-toggle]").addEventListener("click", () => {
        this.applyViewSetting(
          "activityStreamDetailedCards",
          this.root.dataset.activityStreamCards !== "detailed",
        );
        this.update(wrapper);
      });
      wrapper.querySelector("[data-activity-task-separate-toggle]").addEventListener("click", () => {
        this.applyViewSetting(
          "activityTasksSeparateColumn",
          !this.root.hasAttribute("data-activity-tasks-auto-separate"),
        );
        this.update(wrapper);
      });
      wrapper.querySelector("[data-activity-task-always-separate-toggle]").addEventListener("click", () => {
        this.applyViewSetting(
          "activityTasksAlwaysSeparateColumn",
          !this.root.hasAttribute("data-activity-tasks-always-separate"),
        );
        this.update(wrapper);
      });
      wrapper.querySelector("[data-stream-status-effect-select]").addEventListener("change", (event) => {
        this.applyViewSetting("streamStatusEffect", event.currentTarget.value);
        this.update(wrapper);
      });
      wrapper.querySelector("[data-stream-status-fill-toggle]").addEventListener("click", () => {
        this.applyViewSetting(
          "streamStatusStyle",
          this.root.dataset.streamStatusStyle === "fill" ? "edge" : "fill",
        );
        this.update(wrapper);
      });
      const range = wrapper.querySelector("[data-stream-card-width]");
      range.addEventListener("input", (event) => {
        this.fixedWidth = Math.min(
          STREAM_CARD_MAX_WIDTH,
          Math.max(STREAM_CARD_MIN_WIDTH, Number(event.currentTarget.value) || STREAM_CARD_MIN_WIDTH),
        );
        setTextContentIfChanged(
          wrapper.querySelector("[data-stream-card-width-value]"),
          this.fixedWidth,
        );
        this.update(wrapper);
      });
      range.addEventListener("change", () => {
        this.emitSetting("streamCardFixedWidth", this.fixedWidth);
        this.refreshOverflow();
      });
      range.addEventListener("pointerup", () => this.refreshOverflow());
      return wrapper;
    }

    applySettings(value) {
      const settings = normalizeStreamCardSettings(value);
      if (settings.widthMode === STREAM_CARD_WIDTH_MODES.AUTO
        && this.widthMode !== STREAM_CARD_WIDTH_MODES.AUTO) this.autoWidths.clear();
      this.widthMode = settings.widthMode;
      this.fixedWidth = settings.fixedWidth;
      this.gapEnabled = settings.gapEnabled;
      if (Object.hasOwn(value ?? {}, "activityRecentMinutes")) {
        this.activityRecentMinutes = normalizeActivityRecentMinutes(value.activityRecentMinutes);
      }
      if (this.wrapper?.isConnected) this.update(this.wrapper);
      else this.schedule();
      this.refreshOverflow();
      return settings;
    }

    emitSetting(key, value) {
      this.document.dispatchEvent(new this.window.CustomEvent(
        STREAM_CARD_SETTINGS_CHANGE_EVENT,
        { detail: { key, value } },
      ));
    }

    emitViewSetting(key, value) {
      this.document.dispatchEvent(new this.window.CustomEvent(
        STREAM_VIEW_SETTINGS_CHANGE_EVENT,
        { detail: { key, value } },
      ));
    }

    applyViewSetting(key, value) {
      if (!this.themeLabPreview) {
        this.emitViewSetting(key, value);
        return;
      }
      if (key === "activityStreamDetailedCards") {
        const detailed = Boolean(value);
        if (detailed) this.root.dataset.activityStreamCards = "detailed";
        else delete this.root.dataset.activityStreamCards;
        try {
          this.window.localStorage.setItem(ACTIVITY_STREAM_DETAILED_CARDS_KEY, String(detailed));
        } catch {}
      } else if (key === "streamStatusEffect") {
        this.root.dataset.streamStatusEffect = String(value || "impulse");
        try {
          this.window.localStorage.setItem(STREAM_STATUS_EFFECT_KEY, this.root.dataset.streamStatusEffect);
        } catch {}
      } else if (key === "streamStatusStyle") {
        this.root.dataset.streamStatusStyle = value === "fill" ? "fill" : "edge";
        try {
          this.window.localStorage.setItem(STREAM_STATUS_STYLE_KEY, this.root.dataset.streamStatusStyle);
        } catch {}
      }
      this.emitViewSetting(key, value);
    }

    orderMode() {
      return this.tabs.dataset.orderMode === STREAM_ORDER_MODES.MANUAL
        ? STREAM_ORDER_MODES.MANUAL
        : STREAM_ORDER_MODES.ACTIVITY;
    }

    update(wrapper) {
      const orderMode = this.orderMode();
      wrapper.querySelectorAll("[data-stream-order-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.streamOrderMode === orderMode));
      });
      this.tabs.dataset.streamCardWidthMode = this.widthMode;
      if (this.widthMode === STREAM_CARD_WIDTH_MODES.FIXED) {
        this.tabs.style.setProperty("--stream-card-width", `${this.fixedWidth}px`);
      } else {
        this.tabs.style.removeProperty("--stream-card-width");
      }
      wrapper.querySelectorAll("[data-stream-width-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.streamWidthMode === this.widthMode));
      });
      const range = wrapper.querySelector("[data-stream-card-width]");
      if (range) range.value = String(this.fixedWidth);
      const widthValue = wrapper.querySelector("[data-stream-card-width-value]");
      setTextContentIfChanged(widthValue, this.fixedWidth);
      this.tabs.dataset.streamCardGapMode = this.gapEnabled ? "on" : "off";
      wrapper.querySelector("[data-stream-gap-toggle]")
        ?.setAttribute("aria-checked", String(this.gapEnabled));
      const recentHours = Math.round(this.activityRecentMinutes / 30) / 2;
      const recentHoursInput = wrapper.querySelector("[data-stream-recent-hours]");
      if (recentHoursInput) recentHoursInput.value = String(recentHours);
      wrapper.querySelector("[data-stream-detailed-toggle]")?.setAttribute(
        "aria-checked",
        String(this.root.dataset.activityStreamCards === "detailed"),
      );
      wrapper.querySelector("[data-activity-task-separate-toggle]")?.setAttribute(
        "aria-checked",
        String(this.root.hasAttribute("data-activity-tasks-auto-separate")),
      );
      const alwaysSeparateSetting = wrapper.querySelector("[data-activity-task-always-separate-setting]");
      if (alwaysSeparateSetting) {
        alwaysSeparateSetting.hidden = !this.root.hasAttribute("data-activity-tasks-auto-separate");
      }
      wrapper.querySelector("[data-activity-task-always-separate-toggle]")?.setAttribute(
        "aria-checked",
        String(this.root.hasAttribute("data-activity-tasks-always-separate")),
      );
      const effectSelect = wrapper.querySelector("[data-stream-status-effect-select]");
      if (effectSelect) effectSelect.value = this.root.dataset.streamStatusEffect || "impulse";
      wrapper.querySelector("[data-stream-status-fill-toggle]")?.setAttribute(
        "aria-checked",
        String(this.root.dataset.streamStatusStyle === "fill"),
      );
      const rangeWrap = wrapper.querySelector("[data-stream-card-range]");
      if (rangeWrap) rangeWrap.hidden = this.widthMode !== STREAM_CARD_WIDTH_MODES.FIXED;
      this.updateCardPresentation();
    }

    updateCardPresentation() {
      this.tabs.querySelectorAll(".stream-tab .task-time").forEach((time) => {
        const value = compactStreamActivityValue(time.textContent);
        if (value !== time.textContent.trim()) {
          if (!time.style.getPropertyValue("--stream-task-time-font-size")) {
            time.style.setProperty(
              "--stream-task-time-font-size",
              this.window.getComputedStyle(time).fontSize,
            );
          }
          time.dataset.compactStreamTime = value;
        } else {
          delete time.dataset.compactStreamTime;
        }
      });
      this.tabs.querySelectorAll(".stream-tab").forEach((tab) => {
        const streamId = tab.dataset.streamTabId;
        if (this.widthMode === STREAM_CARD_WIDTH_MODES.FIXED) {
          const width = `${this.fixedWidth}px`;
          tab.style.setProperty("box-sizing", "border-box", "important");
          tab.style.setProperty("flex", `0 0 ${width}`, "important");
          tab.style.setProperty("max-width", width, "important");
          tab.style.setProperty("min-width", width, "important");
          tab.style.setProperty("padding-inline", "0.5rem", "important");
          tab.style.setProperty("width", width, "important");
        } else {
          const stableWidth = resolveStableStreamCardWidth(this.autoWidths, streamId);
          if (stableWidth > 0) {
            const width = `${stableWidth}px`;
            tab.style.setProperty("box-sizing", "border-box", "important");
            tab.style.setProperty("flex", `0 0 ${width}`, "important");
            tab.style.setProperty("max-width", width, "important");
            tab.style.setProperty("min-width", width, "important");
            tab.style.removeProperty("padding-inline");
            tab.style.setProperty("width", width, "important");
          } else {
            for (const property of [
              "box-sizing",
              "flex",
              "max-width",
              "min-width",
              "padding-inline",
              "width",
            ]) tab.style.removeProperty(property);
          }
        }
      });
      this.window.requestAnimationFrame(() => {
        this.tabs.querySelectorAll(".stream-tab").forEach((tab) => {
          if (this.widthMode === STREAM_CARD_WIDTH_MODES.AUTO) {
            const width = resolveStableStreamCardWidth(
              this.autoWidths,
              tab.dataset.streamTabId,
              tab.getBoundingClientRect().width,
            );
            if (width > 0) {
              tab.style.setProperty("box-sizing", "border-box", "important");
              tab.style.setProperty("flex", `0 0 ${width}px`, "important");
              tab.style.setProperty("max-width", `${width}px`, "important");
              tab.style.setProperty("min-width", `${width}px`, "important");
              tab.style.setProperty("width", `${width}px`, "important");
            }
          }
          const title = tab.querySelector(".stream-tab-title");
          if (!title) return;
          if (title.scrollWidth > title.clientWidth) {
            title.title = tab.dataset.streamName || title.textContent.trim();
          } else {
            title.removeAttribute("title");
          }
        });
      });
    }

    refreshOverflow() {
      this.window.requestAnimationFrame(() => {
        this.window.dispatchEvent(new this.window.Event("resize"));
      });
    }

    alignOverflow() {
      const visibleTabs = [...this.tabs.querySelectorAll(".stream-tabs-track .stream-tab")]
        .filter((tab) => tab.getBoundingClientRect().width > 0);
      const lastVisible = visibleTabs.at(-1);
      const moreButton = this.tabs.querySelector(".stream-tabs-more");
      if (!lastVisible || !moreButton || moreButton.getBoundingClientRect().width === 0) {
        this.tabs.style.removeProperty("--stream-overflow-shift");
        return;
      }
      const currentShift = Number.parseFloat(
        this.tabs.style.getPropertyValue("--stream-overflow-shift") || "0",
      ) || 0;
      const shift = calculateOverflowShift(
        moreButton.getBoundingClientRect().left,
        lastVisible.getBoundingClientRect().right,
        currentShift,
      );
      const value = `${shift}px`;
      if (this.tabs.style.getPropertyValue("--stream-overflow-shift") !== value) {
        this.tabs.style.setProperty("--stream-overflow-shift", value);
      }
    }

    close(wrapper) {
      const button = wrapper?.querySelector("[data-stream-card-settings-toggle]");
      const menu = wrapper?.querySelector("[data-stream-card-settings-menu]");
      if (!button || !menu) return;
      this.open = false;
      button.setAttribute("aria-expanded", "false");
      menu.hidden = true;
    }
  }

  let installedStreamCardSettings = null;

  function installStreamCardSettings(documentRef, windowRef) {
    installedStreamCardSettings = new StreamCardSettingsController(documentRef, windowRef);
    return installedStreamCardSettings;
  }

  function applyStreamCardSettings(settings) {
    const normalized = normalizeStreamCardSettings(settings);
    installedStreamCardSettings?.applySettings(settings);
    return normalized;
  }

  window.AgentHubStreamTabs = Object.freeze({
    answerArrivalTaskIds,
    archiveStreamIntent,
    activityStreamSections,
    attentionStreamCount,
    createPhosphorIcon,
    HorizontalPointerScroller,
    includeTaskInActivityRail,
    isExactActiveUserTurn,
    orderWorkspaceGroups,
    workspaceSections,
    resolveTaskHierarchy,
    STREAM_CARD_MAX_WIDTH,
    STREAM_CARD_MIN_WIDTH,
    STREAM_CARD_SETTINGS_CHANGE_EVENT,
    STREAM_CARD_WIDTH_MODES,
    STREAM_VIEW_SETTINGS_CHANGE_EVENT,
    streamCardSettingsAvailable,
    streamCardSettingsWrapperNeedsReplacement,
    setTextContentIfChanged,
    STREAM_ORDER_MODES,
    calculateOverflowShift,
    compactStreamActivityValue,
    applyStreamCardSettings,
    installStreamCardSettings,
    normalizeActivityRecentMinutes,
    normalizePinnedWorkspaceStreams,
    normalizeQuickMessages,
    normalizeStreamCardSettings,
    normalizeStreamOrderMode,
    applyOpenStreamSelection,
    orderWorkspaceStreams,
    pinnedStreamActionLabel,
    pinnedStreamActionTitle,
    pinnedWorkspaceStreamIds,
    preserveStreamOverflowMenuOpen,
    quickMessagesForStream,
    quickMessagesFromText,
    quickMessagesToText,
    representativeSnapshotTasks,
    reconcileOpenStreamIds,
    resolveStableStreamCardWidth,
    rotationMaintenancePresentation,
    streamDeckRenderKey,
    streamHeadTasks,
    streamLastActivity,
    streamRotationTransitions,
    streamIsPinned,
    streamStatusPresentation,
    streamStatusState,
    streamsAreDraggable,
    setQuickMessagesForScope,
    taskListSections,
    togglePinnedWorkspaceStream,
  });

  if (typeof document !== "undefined") {
    const start = () => installStreamCardSettings(document, window);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
})();
