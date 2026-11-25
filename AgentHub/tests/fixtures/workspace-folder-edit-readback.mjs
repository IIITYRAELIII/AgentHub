import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";

const [databaseFile,folderId,inputJson]=process.argv.slice(2);
const store=new WorkspaceCatalogStore({databaseFile});
try {
  await store.load();
  const input=JSON.parse(inputJson);
  const receipt=store.workspaceFolderCommandResult(input);
  // Original identity replay must read the same durable result, without re-editing.
  const replay=store.workspaceFolderCommand(input);
  process.stdout.write(JSON.stringify({folder:store.workspaceFolderCatalog().folders.find(folder=>folder.id===folderId),receipt,replay}));
} finally {store.close();}
