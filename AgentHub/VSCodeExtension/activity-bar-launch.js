"use strict";

const CLOSE_PRIMARY_SIDEBAR = "workbench.action.closeSidebar";

async function openEditorFromActivityBar({ openEditor, executeCommand }) {
  let opening;
  try {
    opening = Promise.resolve(openEditor());
  } finally {
    await executeCommand(CLOSE_PRIMARY_SIDEBAR);
  }
  return opening;
}

module.exports = { CLOSE_PRIMARY_SIDEBAR, openEditorFromActivityBar };
