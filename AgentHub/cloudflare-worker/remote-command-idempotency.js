"use strict";

(() => {
  const STORAGE_KEY = "agent-hub:remote-commands:v1";
  const RETENTION_MS = 25 * 60 * 1_000;
  const MAX_RECORDS = 100;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${stableStringify(value[key])}`
      )).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }

  function create({
    storage = globalThis.localStorage,
    cryptoImpl = globalThis.crypto,
    now = () => Date.now(),
  } = {}) {
    let memoryRecords = {};

    function readRecords() {
      try {
        const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // Недоступный или повреждённый localStorage не ломает управление.
      }
      return memoryRecords;
    }

    function writeRecords(records) {
      memoryRecords = records;
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(records));
      } catch {
        // В приватном WebView состояние остаётся хотя бы до перезагрузки.
      }
    }

    function prunedRecords(records, timestamp) {
      return Object.fromEntries(
        Object.entries(records)
          .filter(([, record]) => (
            UUID_PATTERN.test(String(record?.id ?? ""))
            && Number.isFinite(Number(record?.createdAt))
            && timestamp - Number(record.createdAt) < RETENTION_MS
          ))
          .sort(([, left], [, right]) => Number(right.createdAt) - Number(left.createdAt))
          .slice(0, MAX_RECORDS),
      );
    }

    async function fingerprint(action, params) {
      const source = new TextEncoder().encode(`${String(action)}\n${stableStringify(params)}`);
      const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", source));
      return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    }

    async function acquire(action, params) {
      const key = await fingerprint(action, params);
      const timestamp = now();
      const records = prunedRecords(readRecords(), timestamp);
      const existing = records[key];
      const id = UUID_PATTERN.test(String(existing?.id ?? ""))
        ? String(existing.id)
        : cryptoImpl.randomUUID();
      records[key] = {
        id,
        createdAt: existing ? Number(existing.createdAt) : timestamp,
      };
      writeRecords(prunedRecords(records, timestamp));
      return { key, id };
    }

    function release({ key, id }) {
      const records = prunedRecords(readRecords(), now());
      if (String(records[key]?.id ?? "") !== String(id)) return false;
      delete records[key];
      writeRecords(records);
      return true;
    }

    function releaseById(id) {
      const records = prunedRecords(readRecords(), now());
      const entry = Object.entries(records).find(([, record]) => String(record?.id ?? "") === String(id));
      if (!entry) return false;
      delete records[entry[0]];
      writeRecords(records);
      return true;
    }

    return Object.freeze({ acquire, release, releaseById });
  }

  function requestUrl(input) {
    try {
      return new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
        globalThis.location?.href ?? "https://agent-hub.invalid/",
      );
    } catch {
      return null;
    }
  }

  function installFetchInterceptor({
    state = create(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== "function") return null;
    const wrappedFetch = async (input, init) => {
      const url = requestUrl(input);
      const method = String(init?.method ?? (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET")).toUpperCase();
      if (url?.pathname === "/api/control" && method === "POST" && typeof init?.body === "string") {
        let payload;
        try {
          payload = JSON.parse(init.body);
        } catch {
          return fetchImpl(input, init);
        }
        if (payload && typeof payload.action === "string" && payload.params && typeof payload.params === "object") {
          const command = await state.acquire(payload.action, payload.params);
          let response;
          try {
            response = await fetchImpl(input, {
              ...init,
              body: JSON.stringify({ ...payload, commandId: command.id }),
            });
          } catch (error) {
            throw error;
          }
          if (!response.ok && response.status < 500) state.release(command);
          return response;
        }
      }
      const response = await fetchImpl(input, init);
      if (url?.pathname === "/api/control/result" && method === "GET") {
        if (response.status !== 202 && response.status < 500) {
          state.releaseById(url.searchParams.get("id") ?? "");
        }
      }
      return response;
    };
    globalThis.fetch = wrappedFetch;
    return wrappedFetch;
  }

  globalThis.AgentHubRemoteCommandState = Object.freeze({ create, installFetchInterceptor });
  installFetchInterceptor();
})();
