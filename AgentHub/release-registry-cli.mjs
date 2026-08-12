#!/usr/bin/env node
import { callDesktopControl } from "./desktop-control.mjs";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function required(name) {
  const value = argument(name).trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const command = String(process.argv[2] ?? "").trim().toLowerCase();
const workspaceId = required("--workspace");
let result;

if (command === "list") {
  result = await callDesktopControl("read-workspace-release-registry", {
    workspaceId,
    limit: argument("--limit", "50"),
  });
} else if (command === "plan") {
  result = await callDesktopControl("read-workspace-release-plan", { workspaceId });
} else if (command === "status") {
  result = await callDesktopControl("update-release-change-status", {
    workspaceId,
    changeId: required("--change"),
    status: required("--status"),
  });
} else if (command === "complete") {
  result = await callDesktopControl("complete-workspace-release", { workspaceId });
} else {
  throw new Error("usage: release-registry-cli.mjs <list|plan|status|complete> --workspace <id>");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
