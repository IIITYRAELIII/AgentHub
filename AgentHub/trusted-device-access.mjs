export function resolveTrustedDeviceUserId(allowedUserIds, context = null) {
  const requested = String(context?.userId ?? "").trim();
  const allowed = [...(allowedUserIds ?? [])].map(String);
  const userId = requested || allowed[0] || "";
  if (!userId || !allowed.includes(userId)) {
    throw new Error("Пользователь устройства не разрешён");
  }
  return userId;
}
