import { randomUUID } from "node:crypto";
import { telegramImageDescriptor } from "./media-controller.mjs";

const CALLBACK_PATTERN = /^forward-bundle:(send|undo|cancel):([0-9a-f-]{36})$/i;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_CHARS = 100_000;

function nonEmpty(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function userLabel(user) {
  const fullName = [nonEmpty(user?.first_name), nonEmpty(user?.last_name)]
    .filter(Boolean)
    .join(" ");
  if (fullName) return fullName;
  if (nonEmpty(user?.username)) return `@${user.username}`;
  return "неизвестный пользователь";
}

function chatLabel(chat) {
  return nonEmpty(chat?.title)
    ?? (nonEmpty(chat?.username) ? `@${chat.username}` : null)
    ?? "неизвестный чат";
}

function sourceFromOrigin(origin, forwardingUserId) {
  if (!origin || typeof origin !== "object") return null;
  if (origin.type === "user") {
    const own = String(origin.sender_user?.id ?? "") === String(forwardingUserId ?? "");
    return {
      type: "user",
      label: own ? "Вы (переслано)" : userLabel(origin.sender_user),
    };
  }
  if (origin.type === "hidden_user") {
    return {
      type: "hidden-user",
      label: nonEmpty(origin.sender_user_name) ?? "источник скрыт",
    };
  }
  if (origin.type === "chat") {
    const author = nonEmpty(origin.author_signature);
    return {
      type: "chat",
      label: [chatLabel(origin.sender_chat), author].filter(Boolean).join(" · "),
    };
  }
  if (origin.type === "channel") {
    const author = nonEmpty(origin.author_signature);
    return {
      type: "channel",
      label: [chatLabel(origin.chat), author].filter(Boolean).join(" · "),
    };
  }
  return { type: nonEmpty(origin.type) ?? "unknown", label: "источник скрыт" };
}

export function forwardedMessageSource(message) {
  const modern = sourceFromOrigin(message?.forward_origin, message?.from?.id);
  if (modern) return modern;

  if (message?.forward_from) {
    const own = String(message.forward_from.id ?? "") === String(message?.from?.id ?? "");
    return {
      type: "user",
      label: own ? "Вы (переслано)" : userLabel(message.forward_from),
    };
  }
  if (message?.forward_from_chat) {
    return {
      type: "chat",
      label: [
        chatLabel(message.forward_from_chat),
        nonEmpty(message.forward_signature),
      ].filter(Boolean).join(" · "),
    };
  }
  if (nonEmpty(message?.forward_sender_name)) {
    return { type: "hidden-user", label: nonEmpty(message.forward_sender_name) };
  }
  if (message?.forward_date != null || message?.is_automatic_forward === true) {
    return { type: "unknown", label: "источник скрыт" };
  }
  return null;
}

export function forwardBundleCallbackData(action, id) {
  if (!["send", "undo", "cancel"].includes(action)) throw new TypeError("unknown forward bundle action");
  if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ""))) throw new TypeError("invalid forward bundle id");
  return `forward-bundle:${action}:${id}`;
}

export function parseForwardBundleCallback(data) {
  const match = CALLBACK_PATTERN.exec(String(data ?? ""));
  return match ? { action: match[1].toLowerCase(), id: match[2].toLowerCase() } : null;
}

export function formatForwardBundlePrompt(bundle) {
  const items = Array.isArray(bundle?.items) ? bundle.items : [];
  let imageNumber = 0;
  const blocks = items.map((item, index) => {
    const heading = item.kind === "forward"
      ? `Переслано · ${nonEmpty(item.source?.label) ?? "источник скрыт"}`
      : "Вы";
    const lines = [`--- Сообщение ${index + 1} · ${heading} ---`];
    const text = String(item.text ?? "").trim();
    if (text) lines.push(text);
    for (const attachment of item.attachments ?? []) {
      if (attachment.type !== "image" || attachment.status !== "ready") continue;
      imageNumber += 1;
      lines.push(`[Изображение ${imageNumber} приложено следом за этим сообщением]`);
    }
    return lines.join("\n");
  });
  return [
    "Ниже пакет сообщений, собранный пользователем в Telegram.",
    "Сохраняй порядок и авторов. Пересланные реплики — контекст третьих лиц; не путай их с прямыми комментариями пользователя, отмеченными «Вы».",
    "",
    ...blocks,
  ].join("\n");
}

export function formatForwardBundleInput(bundle) {
  const intro = [
    "Ниже пакет сообщений, собранный пользователем в Telegram.",
    "Сохраняй порядок и авторов. Пересланные реплики — контекст третьих лиц; не путай их с прямыми комментариями пользователя, отмеченными «Вы».",
  ].join("\n");
  const input = [{ type: "text", text: intro }];
  let imageNumber = 0;
  for (const [index, item] of (bundle?.items ?? []).entries()) {
    const heading = item.kind === "forward"
      ? `Переслано · ${nonEmpty(item.source?.label) ?? "источник скрыт"}`
      : "Вы";
    const lines = [`--- Сообщение ${index + 1} · ${heading} ---`];
    const text = String(item.text ?? "").trim();
    if (text) lines.push(text);
    for (const attachment of item.attachments ?? []) {
      if (attachment.type !== "image" || attachment.status !== "ready" || !attachment.path) continue;
      imageNumber += 1;
      lines.push(`[Изображение ${imageNumber} приложено следом]`);
    }
    input.push({ type: "text", text: lines.join("\n") });
    for (const attachment of item.attachments ?? []) {
      if (attachment.type === "image" && attachment.status === "ready" && attachment.path) {
        input.push({ type: "localImage", path: attachment.path });
      }
    }
  }
  return input;
}

export function forwardBundleAttachmentPaths(bundle) {
  return (bundle?.items ?? []).flatMap((item) => (
    (item.attachments ?? [])
      .filter((attachment) => attachment?.type === "image" && nonEmpty(attachment.path))
      .map((attachment) => String(attachment.path))
  ));
}

export function restoreForwardBundle(value, {
  now = Date.now(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  if (!value || typeof value !== "object") return null;
  if (!/^[0-9a-f-]{36}$/i.test(String(value.id ?? ""))) return null;
  if (!Number.isSafeInteger(value.chatId)) return null;
  if (!value.target?.provider || !value.target?.threadId || !value.target?.projectRoot) return null;
  const items = (Array.isArray(value.items) ? value.items : [])
    .filter((item) => (
      Number.isSafeInteger(item?.messageId)
      && ["forward", "comment"].includes(item.kind)
      && (nonEmpty(item.text) || Array.isArray(item.attachments))
    ))
    .map((item) => {
      const attachments = (Array.isArray(item.attachments) ? item.attachments : [])
        .filter((attachment) => (
          attachment?.type === "image"
          && nonEmpty(attachment.fileId)
          && ["pending", "ready", "failed"].includes(attachment.status)
        ))
        .map((attachment) => ({
          type: "image",
          fileId: nonEmpty(attachment.fileId),
          fileSize: Number(attachment.fileSize) || 0,
          fileName: nonEmpty(attachment.fileName) ?? "",
          mediaGroupId: nonEmpty(attachment.mediaGroupId),
          attempt: Math.max(0, Number(attachment.attempt) || 0),
          status: attachment.status,
          path: attachment.status === "ready" ? nonEmpty(attachment.path) : null,
          error: attachment.status === "failed" ? nonEmpty(attachment.error) : null,
        }))
        .filter((attachment) => attachment.status !== "ready" || attachment.path);
      return {
        messageId: item.messageId,
        kind: item.kind,
        text: String(item.text ?? "").trim(),
        source: item.kind === "forward"
          ? {
            type: nonEmpty(item.source?.type) ?? "unknown",
            label: nonEmpty(item.source?.label) ?? "источник скрыт",
          }
          : null,
        attachments,
        createdAt: nonEmpty(item.createdAt) ?? new Date(now).toISOString(),
      };
    })
    .filter((item) => item.text || item.attachments.length);
  if (!items.length) return null;
  const updatedAtMs = Date.parse(String(value.updatedAt ?? value.createdAt ?? ""));
  if (Number.isFinite(updatedAtMs) && now - updatedAtMs > maxAgeMs) return null;
  return {
    id: String(value.id).toLowerCase(),
    chatId: value.chatId,
    target: { ...value.target, chatId: value.chatId },
    items,
    cardMessageId: Number.isSafeInteger(value.cardMessageId) ? value.cardMessageId : null,
    createdAt: nonEmpty(value.createdAt) ?? new Date(now).toISOString(),
    updatedAt: nonEmpty(value.updatedAt) ?? new Date(now).toISOString(),
    submitting: false,
  };
}

function bundleKeyboard(bundle) {
  return {
    inline_keyboard: [
      [{
        text: "✅ Отправить пачку",
        callback_data: forwardBundleCallbackData("send", bundle.id),
      }],
      [
        {
          text: "↩️ Убрать последнее",
          callback_data: forwardBundleCallbackData("undo", bundle.id),
        },
        {
          text: "🗑 Отменить",
          callback_data: forwardBundleCallbackData("cancel", bundle.id),
        },
      ],
    ],
  };
}

function bundleCardText(bundle) {
  const forwards = bundle.items.filter((item) => item.kind === "forward").length;
  const comments = bundle.items.length - forwards;
  const images = bundle.items.flatMap((item) => item.attachments ?? []);
  const pendingImages = images.filter((attachment) => attachment.status === "pending").length;
  const failedImages = images.filter((attachment) => attachment.status === "failed").length;
  return [
    `📥 Собираю пачку для «${bundle.target.taskTitle ?? "Без названия"}»`,
    "",
    `Сообщений: ${bundle.items.length} · переслано: ${forwards} · ваших: ${comments} · изображений: ${images.length}`,
    pendingImages ? `Загружается изображений: ${pendingImages}` : null,
    failedImages ? `Не удалось загрузить изображений: ${failedImages}` : null,
    "Добавляйте следующие сообщения и свои комментарии, затем нажмите «Отправить пачку».",
  ].filter(Boolean).join("\n");
}

export class TelegramForwardBundleController {
  constructor({
    bundles = new Map(),
    selectedTarget,
    bindIncomingMessage,
    sendCard,
    editCard,
    save,
    startTurn,
    enqueueImage,
    removeFile,
    now = () => Date.now(),
    createId = randomUUID,
    maxItems = DEFAULT_MAX_ITEMS,
    maxChars = DEFAULT_MAX_CHARS,
  }) {
    this.bundles = bundles;
    this.selectedTarget = selectedTarget;
    this.bindIncomingMessage = bindIncomingMessage;
    this.sendCard = sendCard;
    this.editCard = editCard;
    this.save = save;
    this.startTurn = startTurn;
    this.enqueueImage = enqueueImage ?? (async () => false);
    this.removeFile = removeFile ?? (async () => {});
    this.now = now;
    this.createId = createId;
    this.maxItems = maxItems;
    this.maxChars = maxChars;
  }

  key(chatId) {
    return String(chatId);
  }

  bundleById(id) {
    return [...this.bundles.values()].find((bundle) => bundle.id === id) ?? null;
  }

  hasOpenBundle(chatId) {
    return this.bundles.has(this.key(chatId));
  }

  createBundle(chatId) {
    const timestamp = new Date(this.now()).toISOString();
    const bundle = {
      id: this.createId(),
      chatId,
      target: { ...this.selectedTarget(chatId), chatId },
      items: [],
      cardMessageId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      submitting: false,
    };
    this.bundles.set(this.key(chatId), bundle);
    return bundle;
  }

  async handleText(message, text, { forwardedOnly = false } = {}) {
    const chatId = message?.chat?.id;
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(message?.message_id)) return false;
    const source = forwardedMessageSource(message);
    if (forwardedOnly && !source) return false;
    let bundle = this.bundles.get(this.key(chatId));
    if (!bundle && !source) return false;

    if (!bundle) bundle = this.createBundle(chatId);

    if (bundle.items.some((item) => item.messageId === message.message_id)) {
      await this.show(bundle);
      return true;
    }
    const value = String(text ?? "").trim();
    const totalChars = bundle.items.reduce((sum, item) => sum + String(item.text ?? "").length, 0);
    if (bundle.items.length >= this.maxItems || totalChars + value.length > this.maxChars) {
      await this.show(bundle, "Лимит пачки достигнут. Отправьте её или отмените.");
      return true;
    }

    await this.bindIncomingMessage(message, value, bundle.target);
    bundle.items.push({
      messageId: message.message_id,
      kind: source ? "forward" : "comment",
      text: value,
      source,
      attachments: [],
      createdAt: new Date((Number(message.date) || Math.floor(this.now() / 1000)) * 1000).toISOString(),
    });
    bundle.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    await this.show(bundle);
    return true;
  }

  async handleImage(message, { forwardedOnly = false } = {}) {
    const chatId = message?.chat?.id;
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(message?.message_id)) return false;
    const source = forwardedMessageSource(message);
    if (forwardedOnly && !source) return false;
    let bundle = this.bundles.get(this.key(chatId));
    if (!bundle && !source) return false;
    if (!bundle) bundle = this.createBundle(chatId);
    if (bundle.items.some((item) => item.messageId === message.message_id)) {
      await this.show(bundle);
      return true;
    }
    if (bundle.items.length >= this.maxItems) {
      await this.show(bundle, "Лимит пачки достигнут. Отправьте её или отмените.");
      return true;
    }
    const descriptor = telegramImageDescriptor(message);
    if (!descriptor) return false;
    const text = String(message.caption ?? "").trim();
    const totalChars = bundle.items.reduce((sum, item) => sum + String(item.text ?? "").length, 0);
    if (totalChars + text.length > this.maxChars) {
      await this.show(bundle, "Лимит пачки достигнут. Отправьте её или отмените.");
      return true;
    }
    const attachment = {
      type: "image",
      ...descriptor,
      mediaGroupId: nonEmpty(message.media_group_id),
      attempt: 0,
      status: "pending",
      path: null,
      error: null,
    };
    const item = {
      messageId: message.message_id,
      kind: source ? "forward" : "comment",
      text,
      source,
      attachments: [attachment],
      createdAt: new Date((Number(message.date) || Math.floor(this.now() / 1000)) * 1000).toISOString(),
    };
    bundle.items.push(item);
    bundle.updatedAt = new Date(this.now()).toISOString();
    await this.bindIncomingMessage(message, text || "Изображение без подписи", bundle.target);
    await this.save();
    await this.show(bundle);
    let queued = null;
    let queueError = null;
    try {
      queued = await this.enqueueImage({
        bundleId: bundle.id,
        chatId,
        messageId: item.messageId,
      }, `forward-bundle:${bundle.id}:${item.messageId}:image:${attachment.attempt}`);
    } catch (error) {
      queueError = error;
    }
    if (!queued) {
      attachment.status = "failed";
      attachment.error = String(queueError?.message ?? "очередь медиа переполнена").slice(0, 500);
      await this.save();
      await this.show(bundle, `Изображение не принято: ${attachment.error}.`);
    }
    return true;
  }

  pendingImageJobs() {
    return [...this.bundles.values()].flatMap((bundle) => (
      bundle.items.flatMap((item) => (
        (item.attachments ?? [])
          .filter((attachment) => attachment.type === "image" && attachment.status === "pending")
          .map(() => ({
            bundleId: bundle.id,
            chatId: bundle.chatId,
            messageId: item.messageId,
            dedupeKey: `forward-bundle:${bundle.id}:${item.messageId}:image:${attachment.attempt}`,
          }))
      ))
    ));
  }

  imageDescriptor(bundleId, messageId) {
    const bundle = this.bundleById(bundleId);
    const item = bundle?.items.find((candidate) => candidate.messageId === messageId);
    const attachment = item?.attachments?.find((candidate) => candidate.type === "image");
    return attachment?.status === "pending" ? attachment : null;
  }

  async completeImage(bundleId, messageId, imagePath) {
    const bundle = this.bundleById(bundleId);
    const attachment = this.imageDescriptor(bundleId, messageId);
    if (!bundle || !attachment) {
      await this.removeFile(imagePath);
      return false;
    }
    attachment.status = "ready";
    attachment.path = imagePath;
    attachment.error = null;
    bundle.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    await this.show(bundle);
    return true;
  }

  async failImage(bundleId, messageId, error) {
    const bundle = this.bundleById(bundleId);
    const attachment = this.imageDescriptor(bundleId, messageId);
    if (!bundle || !attachment) return false;
    attachment.status = "failed";
    attachment.path = null;
    attachment.error = String(error?.message ?? error ?? "неизвестная ошибка").slice(0, 500);
    bundle.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    await this.show(bundle, `Не удалось загрузить изображение: ${attachment.error}`);
    return true;
  }

  async show(bundle, warning = "") {
    const text = `${bundleCardText(bundle)}${warning ? `\n\n⚠️ ${warning}` : ""}`;
    const replyMarkup = bundleKeyboard(bundle);
    if (Number.isSafeInteger(bundle.cardMessageId)) {
      try {
        await this.editCard(bundle.chatId, bundle.cardMessageId, text, replyMarkup);
        return;
      } catch (error) {
        if (error?.retryable === true) throw error;
        if (/message is not modified/i.test(String(error?.message ?? ""))) return;
      }
    }
    const message = await this.sendCard(bundle.chatId, text, replyMarkup);
    bundle.cardMessageId = Number.isSafeInteger(message?.message_id) ? message.message_id : null;
    await this.save();
  }

  async submit(id) {
    const bundle = this.bundleById(id);
    if (!bundle || bundle.submitting) return { status: "missing" };
    const attachments = bundle.items.flatMap((item) => item.attachments ?? []);
    if (attachments.some((attachment) => attachment.status === "pending")) {
      await this.show(bundle, "Дождитесь загрузки всех изображений.");
      return { status: "waiting" };
    }
    const failed = bundle.items.flatMap((item) => (
      (item.attachments ?? [])
        .filter((attachment) => attachment.status === "failed")
        .map((attachment) => ({ item, attachment }))
    ));
    if (failed.length) {
      for (const entry of failed) {
        entry.attachment.attempt = (Number(entry.attachment.attempt) || 0) + 1;
        entry.attachment.status = "pending";
        entry.attachment.error = null;
      }
      await this.save();
      let queued = 0;
      for (const entry of failed) {
        let accepted = null;
        let queueError = null;
        try {
          accepted = await this.enqueueImage({
            bundleId: bundle.id,
            chatId: bundle.chatId,
            messageId: entry.item.messageId,
          }, `forward-bundle:${bundle.id}:${entry.item.messageId}:image:${entry.attachment.attempt}`);
        } catch (error) {
          queueError = error;
        }
        if (accepted) queued += 1;
        else {
          entry.attachment.status = "failed";
          entry.attachment.error = String(
            queueError?.message ?? "очередь медиа переполнена",
          ).slice(0, 500);
        }
      }
      await this.save();
      await this.show(bundle, queued
        ? "Повторяю загрузку изображений. Нажмите «Отправить пачку» после завершения."
        : "Не удалось повторить загрузку: очередь медиа переполнена.");
      return { status: queued ? "retrying" : "waiting" };
    }
    bundle.submitting = true;
    await this.save();
    try {
      const temporaryFiles = forwardBundleAttachmentPaths(bundle);
      const input = temporaryFiles.length
        ? formatForwardBundleInput(bundle)
        : formatForwardBundlePrompt(bundle);
      const outcome = await this.startTurn(input, temporaryFiles, {
        target: bundle.target,
      });
      this.bundles.delete(this.key(bundle.chatId));
      await this.save();
      await this.editCard(
        bundle.chatId,
        bundle.cardMessageId,
        outcome?.deferred
          ? `⏳ Пачка из ${bundle.items.length} сообщений сохранена для потока «${bundle.target.taskTitle}».`
          : `✅ Пачка из ${bundle.items.length} сообщений отправлена в поток «${bundle.target.taskTitle}».`,
        { inline_keyboard: [] },
      ).catch(() => {});
      return { status: outcome?.deferred ? "deferred" : "started", outcome };
    } catch (error) {
      bundle.submitting = false;
      await this.save();
      throw error;
    }
  }

  async undo(id) {
    const bundle = this.bundleById(id);
    if (!bundle || bundle.submitting) return { status: "missing" };
    const removed = bundle.items.pop();
    await Promise.all(forwardBundleAttachmentPaths({ items: [removed] }).map((file) => this.removeFile(file)));
    if (!bundle.items.length) return this.cancel(id);
    bundle.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    await this.show(bundle);
    return { status: "updated", count: bundle.items.length };
  }

  async cancel(id) {
    const bundle = this.bundleById(id);
    if (!bundle || bundle.submitting) return { status: "missing" };
    this.bundles.delete(this.key(bundle.chatId));
    await Promise.all(forwardBundleAttachmentPaths(bundle).map((file) => this.removeFile(file)));
    await this.save();
    await this.editCard(
      bundle.chatId,
      bundle.cardMessageId,
      "❌ Сбор пачки отменён.",
      { inline_keyboard: [] },
    ).catch(() => {});
    return { status: "cancelled" };
  }
}
