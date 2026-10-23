import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const STAGES = {
  'release-candidate-contour': ['Проверка кандидата', 'Проверка точного кандидата в изолированном окружении.'],
  'agent-hub-full-tests': ['Полные тесты', 'Автоматические проверки кода, Git, SQLite, интерфейса и установки.'],
  'prepare-publication-artifacts': ['Подготовка артефактов', 'Сборка и проверка файлов, необходимых для доставки.'],
  'publish-git': ['Публикация Git', 'Проверка основы и отправка принятого коммита в репозиторий.'],
  'install-runtime-release': ['Установка runtime', 'Установка проверенного runtime с сохранением данных.'],
  'deploy-mini-app-worker': ['Доставка Worker', 'Доставка серверной части Mini App.'],
  'verify-mini-app-worker': ['Проверка Worker', 'Проверка фактически доставленной серверной части.'],
  'activate-runtime-release': ['Активация runtime', 'Штатное переключение на установленную версию.'],
  'install-vscode-extension': ['Расширение VS Code', 'Установка соответствующей версии расширения.'],
};

export function describeTest(name) {
  const rules = [
    [/upload|attachment|blob/iu, 'Вложения и загрузка', 'Проверка передачи файлов, их целостности и сохранения состояния загрузки.'],
    [/release|prerelease|candidate|publication|native.*(?:merge|history)|reviewed.*main/iu, 'Подготовка и выпуск', 'Проверка подготовки, продолжения или доставки выпуска с сохранением его исходной идентичности.'],
    [/sqlite|database|transaction|checkpoint|persistence/iu, 'Сохранение данных', 'Проверка сохранения и повторного чтения состояния, в том числе после сбоя.'],
    [/auth|token|origin|csrf|permission|foreign/iu, 'Доступ и принадлежность', 'Проверка допустимого канала, прав или принадлежности операции.'],
    [/queue|steer|message|dispatch|intake/iu, 'Доставка сообщений', 'Проверка приёма, очереди и доставки сообщений без потери или повторной отправки.'],
    [/history|rotation|rollout|transcript/iu, 'История и ротация', 'Проверка чтения истории и сохранения связи с исходным ходом.'],
    [/restart|shutdown|startup|bootstrap|runtime|lifecycle/iu, 'Запуск и завершение', 'Проверка жизненного цикла, готовности и сохранения состояния при переключении.'],
    [/theme|layout|paint|css|modal|rail|render|viewport/iu, 'Интерфейс', 'Проверка отображения или взаимодействия с интерфейсом.'],
    [/codex|claude|provider|thread|turn/iu, 'Работа с провайдером', 'Проверка связи с провайдером и корректной идентичности потока или хода.'],
  ];
  const found = rules.find(([pattern]) => pattern.test(name));
  return { area: found?.[1] ?? 'Проверка поведения', description: found?.[2] ?? 'Точное проверяемое условие указано в оригинальном названии теста.' };
}

export class TestLog {
  cases = []; tail = []; totalLines = 0; pending = ''; detailNext = false; detail = null;
  append(text) {
    this.pending += text;
    let end;
    while ((end = this.pending.indexOf('\n')) !== -1) {
      this.line(this.pending.slice(0, end).replace(/\r$/u, ''));
      this.pending = this.pending.slice(end + 1);
    }
  }
  line(raw) {
    const line = raw.replace(/\x1b\[[0-9;]*m/gu, '');
    this.totalLines++; this.tail.push(line);
    if (this.tail.length > 200) this.tail.shift(); // Display window; full log remains downloadable.
    if (line.startsWith('test at ')) { this.detailNext = true; return; }
    const match = line.match(/^[✔✖﹣]\s+(.+?)\s+\(([\d.]+)ms\)(?:\s+#.*)?$/u);
    if (match) {
      const status = line[0] === '✔' ? 'passed' : line[0] === '✖' ? 'failed' : 'skipped';
      if (this.detailNext && status === 'failed') {
        this.detail = this.cases.findLast(item => item.status === 'failed' && item.name === match[1]) ?? null;
      } else {
        const item = { id: this.cases.length, name: match[1], status, durationMs: Number(match[2]), ...describeTest(match[1]), details: '' };
        this.cases.push(item); this.detail = null;
      }
      this.detailNext = false; return;
    }
    if (/^[ℹ✔✖]|^==>|^> /u.test(line)) { this.detail = null; this.detailNext = false; }
    else if (this.detail) this.detail.details += line + '\n';
  }
}

async function json(file) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, '')); }
async function containedJson(root, file) { return json(await containedFile(root, file)); }
export async function containedFile(root, file) {
  const [actualRoot, actualFile, info] = await Promise.all([realpath(root), realpath(file), lstat(file)]);
  const relative = path.relative(actualRoot, actualFile);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !info.isFile() || info.isSymbolicLink()) throw new Error('Файл находится вне каталога выпуска или не является обычным файлом.');
  return actualFile;
}

export class ProgressReader {
  constructor({ runtimeRoot, operationId }) { this.root = path.resolve(runtimeRoot); this.operationId = operationId; this.log = new TestLog(); this.offset = 0; this.key = ''; this.decoder = new StringDecoder('utf8'); }
  async locate() {
    const root = path.join(this.root, 'data', 'release-operation-executions');
    const candidates = [];
    for (const dir of await readdir(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const folder = path.join(root, dir.name);
      const runner = await containedJson(root, path.join(folder, 'runner.json')).catch(() => null);
      if (runner?.operationId === this.operationId && Number.isSafeInteger(runner.generation) && runner.generation > 0) candidates.push({ folder, runner });
    }
    candidates.sort((a, b) => b.runner.generation - a.runner.generation || String(b.runner.startedAt).localeCompare(String(a.runner.startedAt)));
    if (!candidates.length) throw new Error('Для этого выпуска пока нет сохранённого pipeline.');
    return candidates[0];
  }
  async snapshot() {
    const { folder, runner } = await this.locate();
    const status = await json(await containedFile(folder, path.join(folder, 'publication-status.json')));
    const logFile = await containedFile(folder, path.resolve(status.logFile));
    const info = await stat(logFile), key = `${folder}:${info.dev}:${info.ino}`;
    if (key !== this.key || info.size < this.offset) { this.key = key; this.offset = 0; this.log = new TestLog(); this.decoder = new StringDecoder('utf8'); }
    if (info.size > this.offset) {
      for await (const chunk of createReadStream(logFile, { start: this.offset, end: info.size - 1 })) this.log.append(this.decoder.write(chunk));
      this.offset = info.size;
    }
    const result = await containedJson(folder, path.join(folder, 'result.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const item of this.log.cases) counts[item.status]++;
    return { run: this.key, operationId: this.operationId, generation: runner.generation,
      observedAt: new Date().toISOString(), startedAt: runner.startedAt, status: status.status,
      currentStep: status.currentStep, error: status.error ?? null, finishedAt: status.finishedAt ?? result?.finishedAt ?? result?.completedAt ?? null, terminalResultPresent: Boolean(result),
      steps: (status.steps ?? []).map(item => ({ ...item, title: STAGES[item.stageId]?.[0] ?? item.label, description: STAGES[item.stageId]?.[1] ?? 'Штатный этап pipeline.' })),
      counts, cases: this.log.cases, lastResult: this.log.cases.at(-1) ?? null,
      failures: this.log.cases.filter(item => item.status === 'failed'), log: this.log.tail.join('\n'),
      logLines: this.log.totalLines, logBytes: info.size, logModifiedAt: info.mtime.toISOString(), logFile };
  }
}
