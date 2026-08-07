export class TelegramDeliveryService {
  constructor({
    dataDir,
    messageLimit,
    appendBindings,
    readBindings,
    removeBindings,
    pendingApprovalMessageIds,
    runTaskTitle,
    samePath,
    taskRuns,
    telegram,
    sendMessageTo,
    deliveryOutbox,
    scheduleDeliveryFlush,
    taskRunKey,
    randomId,
    progressHeading,
    rememberSpeechText,
    taskViewCallbackData,
    completeRun,
    rememberLastMessage,
    rememberLastSeenTurn,
    refreshTaskDiff,
    selectedTask,
    activeTaskTitle,
    activeProjectName,
    showProject,
    taskSwitchSettings,
    showLastMessageReplyMarkup,
    formatTaskSwitchMessage,
    formatTaskAlreadySelectedMessage,
    getProgressController,
    saveState,
    now = () => new Date(),
    logger = console,
  }) {
    Object.assign(this, {
      dataDir,
      messageLimit,
      appendBindings,
      readBindings,
      removeBindings,
      pendingApprovalMessageIds,
      runTaskTitle,
      samePath,
      taskRuns,
      telegram,
      sendMessageTo,
      deliveryOutbox,
      scheduleDeliveryFlush,
      taskRunKey,
      randomId,
      progressHeading,
      rememberSpeechText,
      taskViewCallbackData,
      completeRun,
      rememberLastMessage,
      rememberLastSeenTurn,
      refreshTaskDiff,
      selectedTask,
      activeTaskTitle,
      activeProjectName,
      showProject,
      taskSwitchSettings,
      showLastMessageReplyMarkup,
      formatTaskSwitchMessage,
      formatTaskAlreadySelectedMessage,
      getProgressController,
      saveState,
      now,
      logger,
    });
    this.bindingWriteQueue = Promise.resolve();
  }

  #queueBindingWrite(operation) {
    this.bindingWriteQueue = this.bindingWriteQueue.catch(() => {}).then(operation);
    return this.bindingWriteQueue;
  }

  waitForBindingWrites() {
    return this.bindingWriteQueue;
  }

  runMessageBinding(run, metadata = {}) {
    if (!run?.threadId || !Number.isSafeInteger(run.chatId)) return null;
    return {
      chatId: run.chatId,
      streamId: run.streamId ?? null,
      provider: run.provider,
      threadId: run.threadId,
      projectRoot: run.projectRoot,
      taskTitle: this.runTaskTitle(run),
      createdAt: this.now().toISOString(),
      ...metadata,
    };
  }

  async bindRunMessage(run, message, metadata = {}) {
    const binding = this.runMessageBinding(run, metadata);
    if (!binding || !Number.isSafeInteger(message?.message_id)) return;
    await this.#queueBindingWrite(() => this.appendBindings(this.dataDir, [{
      ...binding,
      messageId: message.message_id,
    }]));
  }

  async sendRunMessage(run, text, extra = {}, bindingMetadata = {}) {
    const message = await this.sendMessageTo(run.chatId, text, extra);
    await this.bindRunMessage(run, message, bindingMetadata).catch((error) => {
      this.logger.error("Cannot bind task message:", error.message);
    });
    return message;
  }

  sameTaskBinding(binding, task, targetChatId = null) {
    return binding?.provider === task?.provider
      && String(binding?.threadId ?? "") === String(task?.threadId ?? "")
      && this.samePath(binding?.projectRoot, task?.projectRoot)
      && (targetChatId == null || binding.chatId === targetChatId);
  }

  async bindIncomingTaskMessage(message, text, target = null) {
    const task = target ?? this.selectedTask();
    if (!task.threadId || !Number.isSafeInteger(message?.message_id)) return;
    await this.#queueBindingWrite(() => this.appendBindings(this.dataDir, [{
      ...task,
      chatId: message.chat.id,
      messageId: message.message_id,
      taskTitle: task.taskTitle ?? this.activeTaskTitle(),
      createdAt: new Date((Number(message.date) || Math.floor(this.now().getTime() / 1000)) * 1000).toISOString(),
      kind: "incoming-user",
      role: "user",
      text: String(text ?? "").trim(),
    }]));
  }

  async deleteTaskMessages(task, targetChatId) {
    const bindings = await this.readBindings(this.dataDir);
    const protectedIds = new Set(this.pendingApprovalMessageIds(targetChatId));
    const maximumAgeMs = 47 * 60 * 60 * 1000;
    const nowMs = this.now().getTime();
    const messageIds = [...new Set(bindings
      .filter((binding) => this.sameTaskBinding(binding, task, targetChatId))
      .filter((binding) => !protectedIds.has(binding.messageId))
      .filter((binding) => {
        const createdAt = Date.parse(String(binding.createdAt ?? ""));
        return Number.isFinite(createdAt) && nowMs - createdAt < maximumAgeMs;
      })
      .map((binding) => binding.messageId))]
      .sort((left, right) => left - right);
    if (!messageIds.length) return 0;

    const removed = new Set();
    for (let start = 0; start < messageIds.length; start += 100) {
      const batch = messageIds.slice(start, start + 100);
      try {
        await this.telegram("deleteMessages", { chat_id: targetChatId, message_ids: batch });
        batch.forEach((messageId) => removed.add(messageId));
      } catch (batchError) {
        this.logger.warn(`Cannot batch-delete task messages: ${batchError.message}`);
        for (const messageId of batch) {
          try {
            await this.telegram("deleteMessage", { chat_id: targetChatId, message_id: messageId });
            removed.add(messageId);
          } catch (error) {
            this.logger.warn(`Cannot delete Telegram message ${messageId}: ${error.message}`);
          }
        }
      }
    }
    if (removed.size) {
      await this.#queueBindingWrite(() => this.removeBindings(
        this.dataDir,
        (binding) => binding.chatId === targetChatId && removed.has(binding.messageId),
      ));
    }
    const run = this.taskRuns.forTask(task);
    if (run) {
      run.progressMessageIds = run.progressMessageIds.filter((messageId) => !removed.has(messageId));
      if (!run.progressMessageIds.length) run.lastProgressText = "";
    }
    return removed.size;
  }

  async sendTaskViewText(run, heading, text, kind) {
    const value = `${heading}\n\n${String(text ?? "").trim()}`;
    for (let start = 0; start < value.length; start += this.messageLimit) {
      await this.sendRunMessage(
        run,
        value.slice(start, start + this.messageLimit),
        {},
        { kind, role: kind === "task-view-user" ? "user" : "assistant" },
      );
    }
  }

  progressOutboxKey(run) {
    return `progress:${this.taskRunKey(run)}`;
  }

  async sendReliableRunMessage(run, text, extra = {}, bindingMetadata = {}, delivery = {}) {
    const body = { chat_id: run.chatId, text: String(text), ...extra };
    if (delivery.supersedeKey) await this.deliveryOutbox.discard({ supersedeKey: delivery.supersedeKey });
    if (!delivery.forceQueue) {
      try {
        const message = await this.telegram("sendMessage", body);
        await this.bindRunMessage(run, message, bindingMetadata).catch((error) => {
          this.logger.error("Cannot bind task message:", error.message);
        });
        return message;
      } catch (error) {
        if (error?.retryable !== true) throw error;
        this.logger.warn(`Telegram delivery will be queued: ${error.message}`);
      }
    }
    const queued = await this.deliveryOutbox.enqueue({
      method: "sendMessage",
      body,
      binding: this.runMessageBinding(run, bindingMetadata),
      groupId: delivery.groupId ?? null,
      sequence: delivery.sequence ?? 0,
      supersedeKey: delivery.supersedeKey ?? null,
    });
    this.scheduleDeliveryFlush(0);
    return { queued: true, outboxId: queued.id };
  }

  async sendRunLongMessage(run, text, {
    speechText = null,
    forceSpeechButton = false,
    reliable = false,
    durable = false,
    silent = false,
    deliveryGroupId = this.randomId(),
    replaceProgressMessageIds = [],
  } = {}) {
    const value = `${this.progressHeading(run, true)}\n\n${String(text)}`;
    const speechId = this.rememberSpeechText(speechText, forceSpeechButton);
    const diffCallbackData = this.taskViewCallbackData({
      action: "diff",
      provider: run.provider,
      threadId: run.threadId,
    }) ?? "task-diff";
    let queued = durable;
    let sequence = 0;
    for (let start = 0; start < value.length; start += this.messageLimit) {
      const isLast = start + this.messageLimit >= value.length;
      const extra = {
        ...(silent ? { disable_notification: true } : {}),
        ...(isLast ? {
          reply_markup: {
            inline_keyboard: [
              ...(speechId ? [[{ text: "🔊 Озвучить", callback_data: `speech:${speechId}` }]] : []),
              [{ text: "Изменения", callback_data: diffCallbackData }],
            ],
          },
        } : {}),
      };
      if (reliable) {
        const result = await this.sendReliableRunMessage(
          run,
          value.slice(start, start + this.messageLimit),
          extra,
          isLast && replaceProgressMessageIds.length
            ? { replacesProgressMessageIds: [...replaceProgressMessageIds] }
            : {},
          { forceQueue: queued, groupId: deliveryGroupId, sequence },
        );
        queued ||= result?.queued === true;
      } else {
        await this.sendRunMessage(run, value.slice(start, start + this.messageLimit), extra);
      }
      sequence += 1;
    }
    return { queued, groupId: deliveryGroupId, nextSequence: sequence };
  }

  async clearDeliveredProgressMessages(targetChatId, values) {
    const messageIds = [...new Set(values ?? [])].filter(Number.isSafeInteger);
    if (!messageIds.length) return;
    for (const messageId of messageIds) {
      await this.telegram("deleteMessage", {
        chat_id: targetChatId,
        message_id: messageId,
      }).catch((error) => {
        this.logger.warn(`Cannot remove completed progress message ${messageId}:`, error.message);
      });
    }
    await this.removeBindings(
      this.dataDir,
      (binding) => binding.chatId === targetChatId && messageIds.includes(binding.messageId),
    ).catch((error) => {
      this.logger.warn("Cannot remove completed progress bindings:", error.message);
    });
  }

  async removeStoredBindings(targetChatId, values) {
    const messageIds = new Set((values ?? []).filter(Number.isSafeInteger));
    if (!messageIds.size) return;
    await this.#queueBindingWrite(() => this.removeBindings(
      this.dataDir,
      (binding) => binding.chatId === targetChatId && messageIds.has(binding.messageId),
    ));
  }

  async recordDeliveredOutbox(item, result) {
    if (!item.binding || !Number.isSafeInteger(result?.message_id)) return;
    const { replacesProgressMessageIds = [], ...storedBinding } = item.binding;
    try {
      await this.#queueBindingWrite(() => this.appendBindings(this.dataDir, [{
        ...storedBinding,
        messageId: result.message_id,
      }]));
      if (item.binding.kind === "progress") {
        const run = this.taskRuns.forTask(item.binding);
        if (!run || run.finalizing) {
          await this.telegram("deleteMessage", {
            chat_id: item.body?.chat_id ?? item.binding.chatId,
            message_id: result.message_id,
          }).catch(() => {});
        } else if (!run.progressMessageIds.includes(result.message_id)) {
          run.progressMessageIds.push(result.message_id);
          run.lastProgressText = String(item.body?.text ?? "");
          this.getProgressController().schedule(run);
          await this.saveState();
        }
      }
    } catch (error) {
      this.logger.error(`Cannot bind queued Telegram delivery ${item.id}:`, error.message);
    }
    if (Array.isArray(replacesProgressMessageIds) && replacesProgressMessageIds.length) {
      await this.clearDeliveredProgressMessages(
        item.body?.chat_id ?? item.binding.chatId,
        replacesProgressMessageIds,
      ).catch((error) => {
        this.logger.error(`Cannot replace progress after Telegram delivery ${item.id}:`, error.message);
      });
    }
  }

  async safelyDeliverRunMessage(run, delivery, description = "сообщение задачи") {
    try {
      return await delivery();
    } catch (error) {
      this.logger.error(
        `Cannot deliver ${description} for task ${run?.threadId ?? run?.id ?? "unknown"}:`,
        error.message,
      );
      return null;
    }
  }

  async finalizeRunDelivery(run, {
    answer,
    message = answer,
    speechText = answer,
    forceSpeechButton = false,
    deliver,
    silent = false,
    complete = true,
  } = {}) {
    run.finalizing = true;
    await this.deliveryOutbox.discard({ supersedeKey: this.progressOutboxKey(run) }).catch((error) => {
      this.logger.error("Cannot discard stale progress delivery:", error.message);
    });
    this.rememberLastMessage(run, answer);
    if (run?.turnId) this.rememberLastSeenTurn(run, run.turnId);
    await this.refreshTaskDiff(run).catch((error) => {
      this.logger.error(`Cannot refresh final diff for task ${run?.threadId ?? run?.id ?? "unknown"}:`, error.message);
    });
    let deliveryResult = null;
    const deliveryRequested = deliver ?? (run?.telegramDeliveryRequested !== false);
    if (deliveryRequested) {
      deliveryResult = await this.sendRunLongMessage(run, message, {
        speechText,
        forceSpeechButton,
        reliable: true,
        durable: true,
        silent,
        replaceProgressMessageIds: run.finishedProgressMessageIds ?? [],
      });
    }
    if (complete) await this.completeRun(run);
    return deliveryResult;
  }

  async sendTaskSelectionNotification({
    targetChatId,
    showLastMessage = true,
    alreadySelected = false,
    selectedTask = null,
    taskTitle = "",
    projectName = "",
    settings = null,
  } = {}) {
    const selected = selectedTask ?? this.selectedTask();
    const selectedTitle = String(taskTitle ?? "").trim() || this.activeTaskTitle();
    const task = {
      ...selected,
      chatId: targetChatId,
      taskTitle: selectedTitle,
    };
    const extra = { parse_mode: "HTML" };
    if (showLastMessage && task.threadId) extra.reply_markup = this.showLastMessageReplyMarkup(task);
    const formatMessage = alreadySelected
      ? this.formatTaskAlreadySelectedMessage
      : this.formatTaskSwitchMessage;
    const message = await this.sendMessageTo(targetChatId, formatMessage({
      task: selectedTitle,
      project: String(projectName ?? "").trim() || this.activeProjectName(),
      showProject: this.showProject(),
      ...(settings ?? this.taskSwitchSettings()),
    }), extra);
    await this.bindRunMessage(task, message).catch((error) => {
      this.logger.error("Cannot bind task-switch message:", error.message);
    });
    return message;
  }
}
