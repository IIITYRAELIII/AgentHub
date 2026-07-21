import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const request = JSON.parse(input);
const text = String(request.text ?? "");
const outputPath = path.resolve(request.outputPath);
console.log(JSON.stringify({ id: request.id, progress: true, phase: "accepted" }));

if (text.includes("[tts-stall]")) {
  setInterval(() => {}, 1000);
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(`${outputPath}.started`, String(process.pid), "utf8");
  if (text.includes("[tts-hold]")) await new Promise((resolve) => setTimeout(resolve, 1200));
  console.log(JSON.stringify({ id: request.id, progress: true, phase: "chunk-complete" }));
  await writeFile(outputPath, Buffer.from("OggS-fake-voice"));
  console.log(JSON.stringify({ id: request.id, ok: true, outputPath }));
}
