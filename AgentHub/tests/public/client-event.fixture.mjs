import { openFixture } from "./composer-production.fixture.mjs";

// Observe the existing public registration API while loading the complete,
// unchanged app/client files. No function-body extraction or test-only product
// exports: callers exercise the same callbacks that normal UI intents invoke.
export async function openClientEventFixture(page, options = {}) {
  await page.addInitScript(() => {
    let api;
    let taskBoard;
    const handlers = new Map();
    window.__clientProjectionFixture = { messages: {}, pagination: {}, live: {}, toasts: [] };
    Object.defineProperty(window, "AgentHubTaskBoard", {
      configurable: true,
      get: () => taskBoard,
      set(value) {
        taskBoard = { ...value, setSnapshot(snapshot) {
          window.__clientProjectionFixture.boardSelection = { workspace: snapshot.selectedWorkspaceId, stream: snapshot.selectedStreamId };
          return value.setSnapshot(snapshot);
        } };
      },
    });
    Object.defineProperty(window, "AgentHub", {
      configurable: true,
      get: () => api,
      set(value) {
        api = value;
        const toast = api.toast.bind(api);
        api.toast = text => { window.__clientProjectionFixture.toasts.push(text); return toast(text); };
        for (const name of ["setMessages", "setMessagesPreservingScroll", "setMessagesForExactNavigation"]) {
          const apply = api[name].bind(api);
          api[name] = (id, messages, ...args) => {
            window.__clientProjectionFixture.messages[id] = structuredClone(messages);
            return apply(id, messages, ...args);
          };
        }
        const paginate = api.setHistoryPagination.bind(api);
        const live = api.setLive.bind(api);
        api.setLive = (id, value) => {
          window.__clientProjectionFixture.live[id] = structuredClone(value);
          return live(id, value);
        };
        const select = api.setSelection.bind(api);
        api.setSelection = (...args) => {
          const result = select(...args);
          window.__clientAppliedVersion = window.__agentHubFixture?.snapshot?.version;
          return result;
        };
        api.setHistoryPagination = (id, value) => {
          window.__clientProjectionFixture.pagination[id] = structuredClone(value);
          return paginate(id, value);
        };
        const on = api.on.bind(api);
        api.on = (type, handler) => {
          const entries = handlers.get(type) ?? [];
          entries.push(handler);
          handlers.set(type, entries);
          return on(type, handler);
        };
      },
    });
    window.__dispatchClientFixture = (type, detail = {}) => {
      if (!handlers.has(type)) throw new Error(`Missing public client event: ${type}`);
      return Promise.all(handlers.get(type).map(handler => handler(detail, type)));
    };
  });
  return openFixture(page, options);
}
