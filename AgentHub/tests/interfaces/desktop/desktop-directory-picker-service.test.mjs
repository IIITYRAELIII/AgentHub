import assert from "node:assert/strict";
import test from "node:test";

import { DesktopDirectoryPickerService } from "../../../src/interfaces/desktop/desktop-directory-picker-service.mjs";

test("Desktop directory picker allows local Agent Hub surfaces", async () => {
  const calls = [];
  const service = new DesktopDirectoryPickerService({
    pickDirectory: async (params) => {
      calls.push(params);
      return { canceled: false, path: "D:\\repo" };
    },
  });
  for (const source of ["desktop-control", "local-mini-app", "local-vscode-webview", "vscode"]) {
    assert.equal((await service.browse({ initialPath: "D:\\repo" }, { source })).path, "D:\\repo");
  }
  assert.equal(calls.length, 4);
});

test("Desktop directory picker rejects remote surfaces", async () => {
  const service = new DesktopDirectoryPickerService({
    pickDirectory: async () => ({ canceled: true, path: "" }),
  });
  await assert.rejects(
    service.browse({}, { source: "trusted-device" }),
    /только в локальном Agent Hub/u,
  );
});
