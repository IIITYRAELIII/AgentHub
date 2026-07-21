export function routeTtsWorkerMessage(pendingRequests, message) {
  const request = pendingRequests.get(message?.id);
  if (!request) return false;
  if (message.progress === true) {
    request.timer?.refresh?.();
    return true;
  }
  pendingRequests.delete(message.id);
  clearTimeout(request.timer);
  if (message.ok) request.resolve(message.outputPath);
  else request.reject(new Error(message.error || "Неизвестная ошибка TTS"));
  return true;
}
