import { fileURLToPath } from "node:url";
import path from "node:path";

import { callDesktopControl } from "./desktop-control.mjs";
import { npmStep, publicationSteps, runStep } from "./publish-all.mjs";
import {
  changedFiles,
  currentRevision,
  readPublicationState,
  writePublicationState,
} from "./publication-state.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(ROOT, "..");

const emptyPlan = () => ({
  runtime: false,
  worker: false,
  android: false,
  desktop: false,
  vscode: false,
  unitTests: false,
  fullTests: false,
  unknown: [],
});

export function classifyPublicationChanges(files) {
  const plan = emptyPlan();
  for (const rawFile of files) {
    const file = rawFile.replaceAll("\\", "/");
    if (file === "CHANGELOG.md"
      || file === "AgentHub/config.example.json"
      || file.endsWith(".md")
      || file.startsWith(".team/")) continue;
    if (!file.startsWith("AgentHub/")) continue;
    const relative = file.slice("AgentHub/".length);
    if (/\.test\.(?:mjs|js)$/u.test(relative) || relative.startsWith("e2e/") || relative.startsWith("ci/")) continue;
    if (relative.startsWith("assets/mini-app/") || relative === "work-log.css") {
      plan.runtime = true;
      plan.worker = true;
      continue;
    }
    if (relative.startsWith("assets/mobile/")) {
      plan.worker = true;
      continue;
    }
    if (relative.startsWith("cloudflare-worker/")) {
      plan.worker = true;
      continue;
    }
    if (relative.startsWith("AndroidApp/")) {
      plan.android = true;
      plan.worker = true;
      continue;
    }
    if (relative.startsWith("DesktopApp/")) {
      plan.desktop = true;
      continue;
    }
    if (relative.startsWith("VSCodeExtension/")) {
      plan.vscode = true;
      continue;
    }
    if (relative === "package.json" || relative.endsWith(".mjs") || relative.endsWith(".ps1") || relative.endsWith(".vbs") || relative.endsWith(".py")) {
      plan.runtime = true;
      plan.unitTests = true;
      continue;
    }
    plan.unknown.push(file);
  }
  return plan;
}

function focusedSteps(plan) {
  if (plan.unknown.length) return publicationSteps();
  const full = publicationSteps({ skipWorker: !plan.worker });
  const byLabel = new Map(full.map((step) => [step.label, step]));
  const steps = [];
  if (plan.fullTests) {
    steps.push(byLabel.get("Полные тесты Agent Hub"));
  } else {
    steps.push(npmStep("Проверка синтаксиса Agent Hub", ["run", "check"]));
    if (plan.unitTests) {
      steps.push(npmStep("Unit-тесты Agent Hub", ["test"]));
    } else if (plan.runtime || plan.worker) {
      steps.push({
        label: "Тесты жизненного цикла сообщений",
        command: process.execPath,
        args: ["--test", "message-lifecycle.test.mjs", "cloudflare-worker/worker.test.mjs"],
      });
    }
  }
  if (plan.vscode || plan.runtime) steps.push(byLabel.get("Тесты расширения VS Code"));
  if (plan.desktop) steps.push(byLabel.get("Сборка и smoke-проверка Agent Hub Desktop"));
  if (plan.android) steps.push(byLabel.get("Сборка Agent Hub Mobile"));
  if (plan.worker) steps.push(byLabel.get("Публикация Mini App Worker"));
  if (plan.runtime) {
    steps.push(byLabel.get("Сборка runtime-релиза"));
    steps.push(byLabel.get("Активация runtime-релиза"));
  }
  if (plan.vscode) steps.push(byLabel.get("Установка расширения VS Code"));
  return steps.filter(Boolean);
}

export function parseChangedArguments(args) {
  let from = "";
  let skipRestart = false;
  let fullTests = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--skip-restart") skipRestart = true;
    else if (args[index] === "--full-tests") fullTests = true;
    else if (args[index] === "--from" && args[index + 1]) from = args[++index];
    else throw new Error(`Неизвестный аргумент: ${args[index]}`);
  }
  return { from, skipRestart, fullTests };
}

export async function publishChanged(args = process.argv.slice(2), {
  run = runStep,
  restart = callDesktopControl,
  readState = readPublicationState,
  writeState = writePublicationState,
  revision = currentRevision,
  diff = changedFiles,
} = {}) {
  const options = parseChangedArguments(args);
  const state = await readState();
  const from = options.from || state?.revision;
  if (!from) throw new Error("Нет исходной точки публикации. Сначала выполните npm run publish:all или укажите --from <commit>.");
  const files = await diff(from, { cwd: REPOSITORY_ROOT });
  const plan = classifyPublicationChanges(files);
  if (options.fullTests) plan.fullTests = true;
  if (plan.unknown.length) console.warn(`Неизвестные пути требуют полной публикации: ${plan.unknown.join(", ")}`);
  for (const step of focusedSteps(plan)) await run(step);
  if (plan.runtime && !options.skipRestart) await restart("restart-server");
  const head = await revision({ cwd: REPOSITORY_ROOT });
  await writeState({ revision: head, publishedAt: new Date().toISOString(), files, plan });
  console.log(`\nВыборочная публикация завершена: ${files.length} изменённых файлов.`);
  return { files, plan, revision: head };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  publishChanged().catch((error) => {
    console.error(`\nПубликация остановлена: ${error.message}`);
    process.exitCode = 1;
  });
}
