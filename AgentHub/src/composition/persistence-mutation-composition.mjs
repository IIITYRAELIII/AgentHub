import {
  createTaskBoardMutationOwner,
  createWorkspaceCatalogMutationOwner,
} from "../application/sqlite-mutation-owner.mjs";

export function createPersistenceMutationCapabilities({
  rawWorkspaceCatalogStore,
  rawTaskBoardStore,
} = {}) {
  return Object.freeze({
    workspaceCatalogStore: createWorkspaceCatalogMutationOwner(rawWorkspaceCatalogStore),
    taskBoardStore: createTaskBoardMutationOwner(rawTaskBoardStore),
  });
}
