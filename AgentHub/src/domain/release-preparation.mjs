export class ReleasePreparationRejectedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.code = "RELEASE_PREPARATION_REJECTED";
  }
}
