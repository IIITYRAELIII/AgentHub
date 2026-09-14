import { createContourExternalEffects } from "../../infrastructure/filesystem/test-contour-external-effects.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { telegramBotApiUrl, telegramFileApiUrl } from "../../infrastructure/telegram/telegram-api.mjs";
import { telegramPrompt } from "./telegram-message.mjs";
import { messageRequestFingerprint } from "../../infrastructure/persistence/message-receipts.mjs";
import { writeTextAtomic } from "../../infrastructure/persistence/state-store.mjs";
import { PersistentTtsWorkerClient } from "../../infrastructure/process/tts-worker-client.mjs";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_TRANSCRIPTION_OUTPUT_BYTES = 1024 * 1024;

export function telegramImageDescriptor(message) {
  const photo = message?.photo?.at(-1);
  const document = message?.document?.mime_type?.startsWith("image/") ? message.document : null;
  const media = photo ?? document;
  if (!media?.file_id) return null;
  return {
    fileId: media.file_id,
    fileSize: Number(media.file_size) || 0,
    fileName: document?.file_name ?? "",
  };
}

export function runBoundedProcess({
  spawnProcess,
  command,
  args,
  options,
  stopProcessTree,
  timeoutMs,
  maxOutputBytes,
  timeoutMessage,
}) {
  return new Promise((resolve, reject) => {
    let worker;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = (error) => {
      if (worker?.pid) void Promise.resolve(stopProcessTree(worker.pid)).catch(() => worker.kill());
      finish(error);
    };
    try {
      worker = spawnProcess(command, args, options);
    } catch (error) {
      finish(error);
      return;
    }
    timer = setTimeout(() => stop(new Error(timeoutMessage)), timeoutMs);
    const append = (current, chunk) => {
      const value = current + String(chunk);
      if (Buffer.byteLength(value, "utf8") > maxOutputBytes) {
        stop(new Error(`вывод процесса превысил ${maxOutputBytes} байт`));
        return current;
      }
      return value;
    };
    worker.stdout.setEncoding("utf8");
    worker.stderr.setEncoding("utf8");
    worker.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    worker.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    worker.once("error", (error) => finish(error));
    worker.once("close", (code) => {
      if (code === 0) finish(null, stdout.trim());
      else finish(new Error(stderr.trim() || `Процесс завершился с кодом ${code}`));
    });
  });
}

export class MediaController {
  constructor({
    config,
    token,
    agentHubRoot,
    telegram,
    sendMessage,
    startTurn,
    activeProjectRoot,
    stopProcessTree,
  }) {
    this.contourExternalEffects = config.testContourRecording
      ? createContourExternalEffects({ root: config.testContourRecording.root }) : null;
    this.config = config;
    this.token = token;
    this.agentHubRoot = agentHubRoot;
    this.telegram = telegram;
    this.sendMessage = sendMessage;
    this.startTurn = startTurn;
    this.activeProjectRoot = activeProjectRoot;
    this.stopProcessTree = stopProcessTree;
    this.imageDir = path.join(config.dataDir, "images");
    this.speechTextsFile = path.join(config.dataDir, "speech-texts.json");
    this.transcribeScript = path.join(this.agentHubRoot, "transcribe.py");
    this.speechTexts = new Map();
    this.writeQueue = Promise.resolve();
    this.ttsWorker = null;
    this.ttsClient = new PersistentTtsWorkerClient({
      spawnWorker: () => {
        this.assertMediaOperation("spawn-tts-worker");
        return spawn(this.config.ttsPythonExe, [
        this.config.ttsWorkerScript,
        "--idle-timeout", String(this.config.ttsIdleTimeoutSeconds),
        "--model", this.config.ttsModel,
        "--speaker", this.config.ttsSpeaker,
        "--cache-dir", this.config.ttsCacheDir,
        "--max-chars", String(this.config.ttsMaxChars),
      ], {
        cwd: this.agentHubRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1", TORCH_HOME: this.config.ttsCacheDir },
      });
      },
      timeoutMs: this.config.ttsRequestTimeoutSeconds * 1000,
      idleTimeoutMs: this.config.ttsIdleTimeoutSeconds * 1000,
      terminateWorker: (worker) => this.stopProcessTree(worker.pid).catch(() => worker.kill()),
      onWorkerChange: (worker) => { this.ttsWorker = worker; },
      onDiagnostic: (message) => {
        if (message) console.error(`[tts] ${message}`);
      },
    });
  }

  assertMediaOperation(operation) {
    if (!this.contourExternalEffects) return;
    this.contourExternalEffects.exclude("media", operation);
    throw Object.assign(new Error("Media is excluded in the recording contour"), { code: "CONTOUR_MEDIA_EXCLUDED" });
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.speechTextsFile, "utf8"));
      if (Array.isArray(saved)) {
        for (const [id, text] of saved.slice(-20)) {
          if (/^[0-9a-f]+$/.test(id) && typeof text === "string" && text.trim()) {
            this.speechTexts.set(id, text);
          }
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") console.error("Cannot read saved speech texts:", error.message);
    }
  }

  speechText(id) {
    return this.speechTexts.get(id);
  }

  rememberSpeechText(text, force = false) {
    const value = String(text ?? "").trim();
    if (!this.config.ttsEnabled
      || !value
      || (!force && value.length < this.config.ttsButtonMinChars)) return null;
    while (this.speechTexts.size >= 100) this.speechTexts.delete(this.speechTexts.keys().next().value);
    const id = randomUUID().replaceAll("-", "").slice(0, 16);
    this.speechTexts.set(id, value);
    void this.saveSpeechTexts().catch((error) => console.error("Cannot save speech texts:", error.message));
    return id;
  }

  saveSpeechTexts() {
    const content = `${JSON.stringify([...this.speechTexts], null, 2)}\n`;
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => writeTextAtomic(this.speechTextsFile, content));
    return this.writeQueue;
  }

  waitForWrites() {
    return this.writeQueue;
  }

  async download(fileId, destination) {
    this.assertMediaOperation("download");
    const file = await this.telegram("getFile", { file_id: fileId });
    const response = await fetch(
      telegramFileApiUrl(this.config.telegramApiBaseUrl, this.token, file.file_path),
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return file;
  }

  async captureImage(descriptor) {
    this.assertMediaOperation("captureImage");
    if (!descriptor?.fileId) throw new Error("Telegram не передал идентификатор изображения");
    if ((descriptor.fileSize ?? 0) > MAX_MEDIA_BYTES) {
      throw new Error("Изображение слишком большое. Максимальный размер — 20 МБ.");
    }
    await mkdir(this.imageDir, { recursive: true });
    const file = await this.telegram("getFile", { file_id: descriptor.fileId });
    const extension = path.extname(descriptor.fileName || file.file_path || "") || ".jpg";
    const imagePath = path.join(this.imageDir, `${randomUUID()}${extension}`);
    try {
      const response = await fetch(
        telegramFileApiUrl(this.config.telegramApiBaseUrl, this.token, file.file_path),
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
      await writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
      return imagePath;
    } catch (error) {
      await unlink(imagePath).catch(() => {});
      throw error;
    }
  }

  async transcribeVoice(message, target) {
    this.assertMediaOperation("transcribeVoice");
    if (!this.config.voiceEnabled) {
      await this.sendMessage(target.chatId, "Голосовые сообщения отключены в конфигурации.");
      return;
    }
    const media = message.voice ?? message.audio;
    if (!media?.file_id) return;
    if ((media.file_size ?? 0) > MAX_MEDIA_BYTES) {
      await this.sendMessage(target.chatId, "Голосовой файл слишком большой. Максимальный размер — 20 МБ.");
      return;
    }

    await this.sendMessage(target.chatId, "🎙 Распознаю голосовое сообщение…");
    await mkdir(this.config.audioDir, { recursive: true });
    const extension = message.voice ? ".ogg" : path.extname(media.file_name ?? "") || ".audio";
    const audioPath = path.join(this.config.audioDir, `${randomUUID()}${extension}`);
    try {
      await this.download(media.file_id, audioPath);
      const transcript = await this.runTranscription(audioPath);
      if (!transcript) {
        await this.sendMessage(target.chatId, "Не удалось распознать речь в сообщении.");
        return;
      }
      await this.sendMessage(target.chatId, `📝 Распознано:\n${transcript}`);
      const prompt = telegramPrompt(message, transcript);
      const clientUserMessageId = target.clientUserMessageId
        ?? `telegram:${message.chat?.id ?? target.chatId}:${message.message_id}`;
      const followUpMode = "queue";
      const messageFingerprint = await messageRequestFingerprint({
        text: prompt,
        attachmentIdentities: [{ id: media.file_id }],
        followUpMode,
      });
      await this.startTurn(prompt, [], {
        forceSpeechButton: true,
        target,
        clientUserMessageId,
        messageFingerprint,
        followUpMode,
      });
    } catch (error) {
      await this.sendMessage(target.chatId, `Ошибка распознавания: ${error.message}`);
    } finally {
      await unlink(audioPath).catch(() => {});
    }
  }

  async analyzeImage(message, target) {
    this.assertMediaOperation("analyzeImage");
    const descriptor = telegramImageDescriptor(message);
    if (!descriptor) return;

    await this.sendMessage(target.chatId, "🖼 Изображение получено, начинаю анализ…");
    let imagePath;
    try {
      imagePath = await this.captureImage(descriptor);
      const prompt = message.caption?.trim()
        || "Проанализируй это изображение с учётом предыдущих сообщений пользователя.";
      const clientUserMessageId = target.clientUserMessageId
        ?? `telegram:${message.chat?.id ?? target.chatId}:${message.message_id}`;
      const followUpMode = "queue";
      const messageFingerprint = await messageRequestFingerprint({
        text: prompt,
        attachmentIdentities: [{ id: descriptor.fileId }],
        followUpMode,
      });
      await this.startTurn([
        { type: "text", text: prompt },
        { type: "localImage", path: imagePath },
      ], [imagePath], {
        target,
        clientUserMessageId,
        messageFingerprint,
        followUpMode,
      });
    } catch (error) {
      if (imagePath) await unlink(imagePath).catch(() => {});
      await this.sendMessage(target.chatId, `Не удалось обработать изображение: ${error.message}`);
    }
  }

  runTranscription(audioPath) {
    this.assertMediaOperation("runTranscription");
    return runBoundedProcess({
      spawnProcess: spawn,
      command: this.config.pythonExe,
      args: [this.transcribeScript, audioPath],
      options: {
        cwd: this.activeProjectRoot(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          WHISPER_MODEL: this.config.whisperModel,
          WHISPER_MODEL_DIR: this.config.whisperModelDir,
          WHISPER_DEVICE: this.config.whisperDevice,
        },
      },
      stopProcessTree: this.stopProcessTree,
      timeoutMs: 5 * 60 * 1000,
      maxOutputBytes: MAX_TRANSCRIPTION_OUTPUT_BYTES,
      timeoutMessage: "превышено время распознавания (5 минут)",
    });
  }

  async synthesizeSpeech(text) {
    this.assertMediaOperation("synthesizeSpeech");
    await mkdir(this.config.ttsDir, { recursive: true });
    const id = randomUUID();
    const outputPath = path.join(this.config.ttsDir, `${randomUUID()}.ogg`);
    return this.ttsClient.request({ id, text, outputPath });
  }

  stop() {
    this.ttsClient.close();
  }

  async sendVoiceFile(targetChatId, voicePath) {
    this.assertMediaOperation("sendVoiceFile");
    const form = new FormData();
    form.append("chat_id", String(targetChatId));
    form.append("voice", new Blob([await readFile(voicePath)], { type: "audio/ogg" }), path.basename(voicePath));
    const response = await fetch(
      telegramBotApiUrl(this.config.telegramApiBaseUrl, this.token, "sendVoice"),
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(5 * 60 * 1000),
      },
    );
    const payload = await response.json();
    if (!payload.ok) throw new Error(`Telegram sendVoice: ${payload.description ?? response.status}`);
    return payload.result;
  }

  async processSpeechRequest(targetChatId, text) {
    this.assertMediaOperation("processSpeechRequest");
    const tick = () => this.telegram("sendChatAction", {
      chat_id: targetChatId,
      action: "record_voice",
    }).catch(() => {});
    const activity = setInterval(tick, 4000);
    tick();
    let voicePath;
    try {
      voicePath = await this.synthesizeSpeech(text);
      await this.sendVoiceFile(targetChatId, voicePath);
    } catch (error) {
      await this.sendMessage(targetChatId, `Не удалось озвучить ответ: ${error.message}`);
    } finally {
      clearInterval(activity);
      if (voicePath) await unlink(voicePath).catch(() => {});
    }
  }
}
