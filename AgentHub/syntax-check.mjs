import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const SKIPPED_DIRECTORIES = new Set(["data", "node_modules"]);
const CONTRACT_ID_PATTERN = /^(?:SYS|MSG|TURN|UI|RST|PERF|REL|MCP|USG|UPD)-\d{3}$/u;

async function verifyContractRegistry(root) {
  const registryFile = path.join(root, "docs", "contracts", "registry.json");
  const registry = JSON.parse(await readFile(registryFile, "utf8"));
  if (registry?.version !== 1 || !Array.isArray(registry.contracts) || !registry.contracts.length) {
    throw new Error("Agent Hub contract registry must contain version 1 contracts");
  }
  const identifiers = new Set();
  for (const contract of registry.contracts) {
    const id = String(contract?.id ?? "").trim();
    if (!CONTRACT_ID_PATTERN.test(id) || identifiers.has(id)) {
      throw new Error(`Invalid or duplicate Agent Hub contract id: ${id || "missing"}`);
    }
    identifiers.add(id);
    if (!String(contract?.title ?? "").trim()) throw new Error(`Agent Hub contract ${id} has no title`);
    if (!Array.isArray(contract?.paths) || !contract.paths.length) {
      throw new Error(`Agent Hub contract ${id} has no affected paths`);
    }
    const document = path.resolve(path.dirname(registryFile), String(contract?.document ?? ""));
    const relative = path.relative(path.dirname(registryFile), document);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Agent Hub contract ${id} document escapes the registry`);
    }
    const source = await readFile(document, "utf8");
    if (!source.includes(id) || !/^#\s+/mu.test(source)) {
      throw new Error(`Agent Hub contract ${id} document is missing its identity or title`);
    }
  }
  return registry.contracts.length;
}

async function verifyAgentHubChangelogContracts(root) {
  const changelog = await readFile(path.join(root, "..", "CHANGELOG.md"), "utf8");
  const boundary = "## 2026-08-25 — Контракты Agent Hub фиксируют принятые решения";
  const boundaryIndex = changelog.indexOf(boundary);
  if (boundaryIndex < 0) throw new Error("Agent Hub contract changelog boundary is missing");
  const sectionStart = changelog.indexOf("\n## ", boundaryIndex + boundary.length);
  const governed = changelog.slice(0, sectionStart < 0 ? changelog.length : sectionStart);
  const sections = governed.split(/(?=^## )/mu).filter((section) => section.includes("`agent-hub`"));
  for (const section of sections) {
    const heading = section.match(/^## .+$/mu)?.[0] ?? "unknown Agent Hub changelog entry";
    if (!/^- `Контракты`: (?:`(?:SYS|MSG|TURN|UI|RST|PERF|REL|MCP|USG|UPD)-\d{3}`(?:,\s*`(?:SYS|MSG|TURN|UI|RST|PERF|REL|MCP|USG|UPD)-\d{3}`)*|`none`)/mu.test(section)) {
      throw new Error(`${heading} has no valid Контракты field`);
    }
  }
  return sections.length;
}

async function moduleFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...await moduleFiles(path.join(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

const root = import.meta.dirname;
const contractCount = await verifyContractRegistry(root);
const governedChangelogCount = await verifyAgentHubChangelogContracts(root);
if (process.argv.includes("--contracts-only")) {
  console.log(`Contracts OK: ${contractCount}; changelog entries: ${governedChangelogCount}`);
  process.exit(0);
}
const files = await moduleFiles(root);
for (const file of files) {
  const source = await readFile(file, "utf8");
  new vm.SourceTextModule(source, { identifier: file });
}
console.log(`Syntax OK: ${files.length} modules; contracts: ${contractCount}; changelog entries: ${governedChangelogCount}`);
