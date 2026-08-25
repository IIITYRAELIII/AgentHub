import { readFile } from "node:fs/promises";
import path from "node:path";

const root = import.meta.dirname;
const registryFile = path.join(root, "docs", "contracts", "registry.json");

function normalizePath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function patternToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character !== "*") {
      source += escapeRegExp(character);
      continue;
    }
    if (normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    source += "[^/]*";
  }
  return new RegExp(`^${source}$`, "u");
}

function matchesContract(contract, file) {
  const normalized = normalizePath(file);
  return contract.paths.some((pattern) => patternToRegExp(pattern).test(normalized));
}

const registry = JSON.parse(await readFile(registryFile, "utf8"));
const [command = "list", ...values] = process.argv.slice(2).filter((value) => value !== "--");
let contracts = registry.contracts;

if (command === "affected") {
  if (!values.length) throw new Error("Usage: contract-registry-cli.mjs affected <path> [...paths]");
  contracts = contracts.filter((contract) => values.some((file) => matchesContract(contract, file)));
} else if (command !== "list") {
  throw new Error(`Unknown contract registry command: ${command}`);
}

for (const contract of contracts) {
  console.log(`${contract.id}\t${contract.document}\t${contract.title}`);
}
