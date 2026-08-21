const MAX_ALBUM_SIZE = 10;

export const NOTIFICATION_CATEGORIES = Object.freeze({
  action: Object.freeze({ emoji: "🚨", title: "ТРЕБУЕТСЯ ДЕЙСТВИЕ" }),
  done: Object.freeze({ emoji: "✅", title: "ПОТОК ЗАВЕРШЁН" }),
  intermediate: Object.freeze({ emoji: "📌", title: "ПРОМЕЖУТОЧНЫЙ РЕЗУЛЬТАТ" }),
  progress: Object.freeze({ emoji: "⏳", title: "ПОТОК ВЫПОЛНЯЕТСЯ" }),
  warning: Object.freeze({ emoji: "⚠️", title: "ВНИМАНИЕ" }),
  info: Object.freeze({ emoji: "ℹ️", title: "ИНФОРМАЦИЯ" }),
});

export function resolveNotificationCategory(value = "info") {
  const key = String(value || "info").trim().toLowerCase();
  const category = NOTIFICATION_CATEGORIES[key];
  if (!category) {
    throw new Error(`Unknown --category value "${value}"; use ${Object.keys(NOTIFICATION_CATEGORIES).join(", ")}`);
  }
  return { key, ...category };
}

export function parseSendMessageArguments(args) {
  let chatId = null;
  let silent = false;
  let bindCurrent = false;
  let bindActive = false;
  let category = "info";
  let messageFile = null;
  const textParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--chat-id") {
      if (index + 1 >= args.length) throw new Error("--chat-id requires a value");
      chatId = args[++index];
    } else if (argument === "--silent") {
      silent = true;
    } else if (argument === "--bind-current") {
      bindCurrent = true;
    } else if (argument === "--bind-active") {
      bindActive = true;
    } else if (argument === "--category") {
      if (index + 1 >= args.length) throw new Error("--category requires a value");
      category = resolveNotificationCategory(args[++index]).key;
    } else if (argument.startsWith("--category=")) {
      category = resolveNotificationCategory(argument.slice("--category=".length)).key;
    } else if (argument === "--message-file") {
      if (index + 1 >= args.length) throw new Error("--message-file requires a value");
      messageFile = args[++index];
    } else if (argument.startsWith("--message-file=")) {
      messageFile = argument.slice("--message-file=".length);
      if (!messageFile) throw new Error("--message-file requires a value");
    } else if (argument === "--help" || argument === "-h") {
      return {
        help: true,
        chatId,
        silent,
        bindCurrent,
        bindActive,
        category,
        messageFile,
        text: "",
      };
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      textParts.push(argument);
    }
  }
  if (bindCurrent && bindActive) throw new Error("Use either --bind-current or --bind-active, not both");
  const text = textParts.join(" ").trim();
  if (messageFile && text) throw new Error("Use either --message-file or positional message text, not both");
  return {
    help: false,
    chatId,
    silent,
    bindCurrent,
    bindActive,
    category,
    messageFile,
    text,
  };
}

export function parseSendImagesArguments(args) {
  let chatId = null;
  let silent = false;
  let bindCurrent = false;
  let bindActive = false;
  let caption = "";
  const files = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--chat-id") {
      if (index + 1 >= args.length) throw new Error("--chat-id requires a value");
      chatId = args[++index];
    } else if (argument === "--caption") {
      if (index + 1 >= args.length) throw new Error("--caption requires a value");
      caption = args[++index];
    } else if (argument === "--silent") {
      silent = true;
    } else if (argument === "--bind-current") {
      bindCurrent = true;
    } else if (argument === "--bind-active") {
      bindActive = true;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, chatId, silent, bindCurrent, bindActive, caption, files };
    } else {
      files.push(argument);
    }
  }

  if (bindCurrent && bindActive) throw new Error("Use either --bind-current or --bind-active, not both");
  if (!files.length && !args.includes("--help") && !args.includes("-h")) {
    throw new Error("Specify at least one image");
  }
  if (files.length > MAX_ALBUM_SIZE) {
    throw new Error(`Telegram albums contain at most ${MAX_ALBUM_SIZE} images`);
  }

  return { help: false, chatId, silent, bindCurrent, bindActive, caption, files };
}
