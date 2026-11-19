import { pathToFileURL } from "node:url";
import { GitHubAccountVault } from "../filesystem/github-account-vault.mjs";

export async function githubCredential({ directory, id, operation, input, vault = new GitHubAccountVault({ directory }) }) {
  const fields = Object.fromEntries(String(input).split(/\r?\n/u).filter(Boolean).map(line => {
    const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)];
  }));
  if (fields.protocol !== "https" || fields.host?.toLowerCase() !== "github.com") return "";
  const row = await vault.read();
  if (!row || row.id !== id) return operation === "get" ? "quit=true\n\n" : "";
  if (operation === "erase") {
    // Git supplies the rejected credential. A late rejection cannot expire a
    // newly connected account or another credential used by the same Git run.
    if (fields.password && fields.password === await vault.token(row)) await vault.reject(id);
    return "";
  }
  if (operation !== "get") return "";
  try { return `username=${row.account.login}\npassword=${await vault.token(row)}\n\n`; }
  catch { return "quit=true\n\n"; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16_384) throw new Error("Git credential input exceeds budget");
  }
  try {
    process.stdout.write(await githubCredential({ directory: process.argv[2], id: process.argv[3], operation: process.argv[4], input }));
  } catch { process.stderr.write("GitHub authorization unavailable; reconnect in Hub\n"); process.exitCode = 1; }
}
