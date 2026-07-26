import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { format } from "node:util";

function backupPath(filePath, index) {
  const extension = path.extname(filePath);
  return `${filePath.slice(0, -extension.length)}.${index}${extension}`;
}

export function rotateLogFile(filePath, maxFiles) {
  if (!existsSync(filePath)) return;
  const lastBackup = backupPath(filePath, maxFiles);
  if (existsSync(lastBackup)) unlinkSync(lastBackup);
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = backupPath(filePath, index);
    if (existsSync(source)) renameSync(source, backupPath(filePath, index + 1));
  }
  renameSync(filePath, backupPath(filePath, 1));
}

export function appendRotatingLog(filePath, text, {
  maxBytes,
  maxFiles,
} = {}) {
  const value = String(text);
  const currentBytes = existsSync(filePath) ? statSync(filePath).size : 0;
  if (currentBytes > 0 && currentBytes + Buffer.byteLength(value, "utf8") > maxBytes) {
    rotateLogFile(filePath, maxFiles);
  }
  appendFileSync(filePath, value, "utf8");
}

export function installRotatingConsole({
  stdoutFile,
  stderrFile,
  maxBytes,
  maxFiles,
  mirror = true,
}) {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const write = (filePath, originalMethod, args) => {
    const line = `${new Date().toISOString()} ${format(...args)}\n`;
    try {
      appendRotatingLog(filePath, line, { maxBytes, maxFiles });
    } catch (error) {
      original.error(`Cannot write rotating log ${filePath}:`, error.message);
    }
    if (mirror) originalMethod(...args);
  };
  console.log = (...args) => write(stdoutFile, original.log, args);
  console.info = (...args) => write(stdoutFile, original.info, args);
  console.warn = (...args) => write(stderrFile, original.warn, args);
  console.error = (...args) => write(stderrFile, original.error, args);
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  };
}
