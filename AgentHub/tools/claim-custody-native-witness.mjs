import { launchClaimCustodyNativeWitness, closeClaimCustodyNativeWitness } from "../src/infrastructure/process/claim-custody-runtime.mjs";
const input = JSON.parse(process.argv[2] ?? "{}");
if (input.action != null && !["capture", "close"].includes(input.action)) throw new Error("Only capture or close of the own read-only witness is available");
const result = input.action === "close"
  ? await closeClaimCustodyNativeWitness(input)
  : await launchClaimCustodyNativeWitness(input);
console.log(JSON.stringify(result));
