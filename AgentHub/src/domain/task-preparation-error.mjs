export class TaskPreparationRejectedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.code = "RELEASE_PREPARATION_REJECTED"; // Preserve historical Task error readback.
  }
}
