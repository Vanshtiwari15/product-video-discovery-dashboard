export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const notFound = (message) => new AppError(404, 'NOT_FOUND', message);
export const unsafeUrl = (message) => new AppError(400, 'UNSAFE_URL', message);

// Errors coming from external sources, carried into the per-source summary shown in the UI.
export class SourceError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}
