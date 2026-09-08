export type KitValidationExceptionOptions = {
  code?: string;
  details?: unknown;
  cause?: unknown;
};

// Domain validation failure. Keep kit validation independent from transport-specific
// error semantics; add subclasses only when orchestration needs them.
export class KitValidationException extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options: KitValidationExceptionOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'KIT_VALIDATION_ERROR';
    this.details = options.details;

    Error.captureStackTrace?.(this, new.target);
  }
}
