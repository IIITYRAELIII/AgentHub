import { register } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readReleaseToolPackage } from "../../src/infrastructure/process/release-tool-package.mjs";
import { releasePublicationPlatform } from "../../src/composition/release-tooling-composition.mjs";

// Existing deep product-owner regression uses controlled lower-level package
// ports. Keep that composition in the test loader, never in Hub's production
// facade or the external recipe's normal installer composition.
export async function controlledProductInstallerOwner(t, createInstaller, options) {
  const tool = await readReleaseToolPackage();
  await tool.assertUnchanged();
  const key = `controlled-product-api-${randomUUID()}`;
  globalThis[key] = createInstaller;
  t.after(() => { delete globalThis[key]; });
  const parent = pathToFileURL(path.join(tool.root, "src/agent-hub-publication.mjs"));
  parent.searchParams.set("testComposition", key);
  register(new URL("./controlled-product-api-loader.fixture.mjs", import.meta.url), {
    data: { parent: parent.href, source: `export const createReleaseOperationPublicInstaller = input => globalThis[${JSON.stringify(key)}](input);` },
  });
  const { createPublicationOwner } = await import(parent.href);
  return createPublicationOwner(options, releasePublicationPlatform());
}
