function messageBody(message) {
  return String(message?.text ?? message?.caption ?? "").trim();
}

export function telegramPrompt(message, currentText = messageBody(message)) {
  const text = String(currentText ?? "").trim();
  const quoted = messageBody(message?.reply_to_message);
  if (!quoted) return text;

  const quote = quoted
    .slice(0, 4000)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `Пользователь отвечает на сообщение:\n${quote}\n\nТекст пользователя:\n${text}`;
}
