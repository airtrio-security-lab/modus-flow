/** Error codes are part of the API contract; HTTP status is derived from them. */
export const ERROR_STATUS = {
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  idempotency_mismatch: 409,
  invalid_transition: 409,
  checks_failed: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export const forbidden = (message = 'Недостаточно полномочий') => new AppError('forbidden', message);
export const notFound = (message = 'Не найдено') => new AppError('not_found', message);
export const conflict = (message: string, details?: unknown) => new AppError('conflict', message, details);
