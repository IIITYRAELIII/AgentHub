export class DesktopReadModelService {
  constructor({
    snapshot,
    readStateStore,
    trustedDeviceUserId,
    hasAllowedUsers = () => false,
    androidEnabled = () => false,
    lastTaskMessage,
  } = {}) {
    if (typeof snapshot !== "function") throw new TypeError("snapshot is required");
    if (!readStateStore || typeof readStateStore.markRead !== "function") {
      throw new TypeError("readStateStore is required");
    }
    if (typeof trustedDeviceUserId !== "function") {
      throw new TypeError("trustedDeviceUserId is required");
    }
    if (typeof lastTaskMessage !== "function") {
      throw new TypeError("lastTaskMessage is required");
    }
    Object.assign(this, {
      snapshotImpl: snapshot,
      readStateStore,
      trustedDeviceUserId,
      hasAllowedUsers,
      androidEnabled,
      lastTaskMessage,
    });
  }

  accountId(context = null) {
    const requested = String(context?.userId ?? "").trim();
    if (requested) return this.trustedDeviceUserId(context);
    if (this.hasAllowedUsers() || this.androidEnabled()) {
      return this.trustedDeviceUserId(null);
    }
    return "local";
  }

  snapshot(params = {}, context = null) {
    return this.snapshotImpl({
      ...(params ?? {}),
      // Read state belongs to the authenticated/local Hub account. Request
      // parameters cannot switch the account whose unread markers are read.
      accountId: this.accountId(context),
    });
  }

  markTaskRead(entry, context = null) {
    const lastMessage = this.lastTaskMessage(entry);
    if (!lastMessage?.updatedAt) return null;
    return this.readStateStore.markRead({
      accountId: this.accountId(context),
      provider: entry.provider,
      threadId: entry.threadId,
      answerAt: lastMessage.updatedAt,
      answerTurnId: lastMessage.turnId,
    });
  }
}
