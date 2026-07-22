import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { telegramBotApiUrl, telegramFileApiUrl } from "./telegram-api.mjs";
import { telegramPrompt } from "./telegram-message.mjs";
import { writeTextAtomic } from "./state-store.mjs";
import { runTtsWorkerRequest } from "./tts-worker-client.mjs";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export class MediaController {
  constructor({
    config,
    token,
    integrationRoot,
    telegram,
    sendMessage,
    startTurn,
    activeProjectRoot,
    stopProcessTree,
  }) {
    this.config = config;
    this.token = token;
    this.integrationRoot = integrationRoot;
    this.telegram = telegram;
    this.sendMessage = sendMessage;
    this.startTurn = startTurn;
    this.activeProjectRoot = activeProjectRoot;
    this.stopProcessTree = stopProcessTree;
    this.imageDir = path.join(config.dataDir, "images");
    this.speechTextsFile = path.join(config.dataDir, "speech-texts.json");
    this.transcribeScript = path.join(import.meta.dirname, "transcribe.py");
    this.speechTexts = new Map();
    this.writeQueue = Promise.resolve();
    this.ttsWorker = null;
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
    const file = await this.telegram("getFile", { file_id: fileId });
    const response = await fetch(
      telegramFileApiUrl(this.config.telegramApiBaseUrl, this.token, file.file_path),
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return file;
  }

  async transcribeVoice(message, target) {
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
      await this.startTurn(telegramPrompt(message, transcript), [], {
        forceSpeechButton: true,
        target,
      });
    } catch (error) {
      await this.sendMessage(target.chatId, `Ошибка распознавания: ${error.message}`);
    } finally {
      await unlink(audioPath).catch(() => {});
    }
  }

  async analyzeImage(message, target) {
    const photo = message.photo?.at(-1);
    const document = message.document?.mime_type?.startsWith("image/") ? message.document : null;
    const media = photo ?? document;
    if (!media?.file_id) return;
    if ((media.file_size ?? 0) > MAX_MEDIA_BYTES) {
      await this.sendMessage(target.chatId, "Изображение слишком большое. Максимальный размер — 20 МБ.");
      return;
    }

    await this.sendMessage(target.chatId, "🖼 Изображение получено, начинаю анализ…");
    await mkdir(this.imageDir, { recursive: true });
    let imagePath;
    try {
      const file = await this.telegram("getFile", { file_id: media.file_id });
      const extension = path.extname(document?.file_name ?? file.file_path ?? "") || ".jpg";
      imagePath = path.join(this.imageDir, `${randomUUID()}${extension}`);
      const response = await fetch(
        telegramFileApiUrl(this.config.telegramApiBaseUrl, this.token, file.file_path),
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok) throw new Error(`Telegram file download: HTTP ${response.status}`);
      await writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
      const prompt = message.caption?.trim()
        || "Проанализируй это изображение с учётом предыдущих сообщений пользователя.";
      await this.startTurn([
        { type: "text", text: prompt },
        { type: "localImage", path: imagePath },
      ], [imagePath], { target });
    } catch (error) {
      if (imagePath) await unlink(imagePath).catch(() => {});
      await this.sendMessage(target.chatId, `Не удалось обработать изображение: ${error.message}`);
    }
  }

  runTranscription(audioPath) {
    return new Promise((resolve, reject) => {
      const worker = spawn(this.config.pythonExe, [this.transcribeScript, audioPath], {
        cwd: this.activeProjectRoot(),
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          WHISPER_MODEL: this.config.whisperModel,
          WHISPER_MODEL_DIR: this.config.whisperModelDir,
        },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        worker.kill();
        reject(new Error("превышено время распознавания (5 минут)"));
      }, 5 * 60 * 1000);
      worker.stdout.setEncoding("utf8");
      worker.stderr.setEncoding("utf8");
      worker.stdout.on("data", (chunk) => { stdout += chunk; });
      worker.stderr.on("data", (chunk) => { stderr += chunk; });
      worker.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `Whisper завершился с кодом ${code}`));
      });
    });
  }

  async synthesizeSpeech(text) {
    await mkdir(this.config.ttsDir, { recursive: true });
    const id = randomUUID();
    const outputPath = path.join(this.config.ttsDir, `${randomUUID()}.ogg`);
    let currentWorker = null;
    return runTtsWorkerRequest({
      spawnWorker: () => spawn(this.config.ttsPythonExe, [
        this.config.ttsWorkerScript,
        "--idle-timeout", String(this.config.ttsIdleTimeoutSeconds),
        "--model", this.config.ttsModel,
        "--speaker", this.config.ttsSpeaker,
        "--cache-dir", this.config.ttsCacheDir,
        "--max-chars", String(this.config.ttsMaxChars),
      ], {
        cwd: this.integrationRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1", TORCH_HOME: this.config.ttsCacheDir },
      }),
      request: { id, text, outputPath },
      timeoutMs: this.config.ttsRequestTimeoutSeconds * 1000,
      terminateWorker: (worker) => this.stopProcessTree(worker.pid).catch(() => worker.kill()),
      onWorkerChange: (worker) => {
        if (worker) {
          currentWorker = worker;
          this.ttsWorker = worker;
        } else if (this.ttsWorker === currentWorker) {
          this.ttsWorker = null;
        }
      },
      onDiagnostic: (message) => {
        if (message) console.error(`[tts] ${message}`);
      },
    });
  }

  stop() {
    const worker = this.ttsWorker;
    if (!worker) return;
    this.ttsWorker = null;
    void this.stopProcessTree(worker.pid).catch(() => worker.kill());
  }

  async sendVoiceFile(targetChatId, voicePath) {
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
