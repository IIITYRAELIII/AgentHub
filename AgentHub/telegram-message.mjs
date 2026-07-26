function messageBody(message) {
  return String(message?.text ?? message?.caption ?? "").trim();
}

export function telegramPrompt(message, currentText = messageBody(message)) {
  const text = String(currentText ?? "").trim();
  const quoted = String(message?.quote?.text ?? messageBody(message?.reply_to_message)).trim();
  if (!quoted) return text;

  const quote = quoted
    .slice(0, 4000)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `Пользователь отвечает на сообщение:\n${quote}\n\nТекст пользователя:\n${text}`;
}
