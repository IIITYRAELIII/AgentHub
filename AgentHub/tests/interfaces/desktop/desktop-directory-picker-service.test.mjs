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
  let calls = 0;
  const service = new DesktopDirectoryPickerService({
    pickDirectory: async () => {
      calls += 1;
      return { canceled: true, path: "" };
    },
  });
  for (const context of [{ source: "trusted-device" }, {}, { source: "" }]) {
    await assert.rejects(
      service.browse({}, context),
      /только в локальном Agent Hub/u,
    );
  }
  assert.equal(calls, 0);
});
