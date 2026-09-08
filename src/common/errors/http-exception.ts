export type HttpExceptionOptions = {
  code?: string;
  details?: unknown;
  expose?: boolean;
  cause?: unknown;
};

export class HttpException extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(statusCode: number, message: string, options: HttpExceptionOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = options.code ?? 'HTTP_ERROR';
    this.details = options.details;
    this.expose = options.expose ?? statusCode < 500;

    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestException extends HttpException {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, message, { code: 'BAD_REQUEST', details });
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message = 'Unauthorized') {
    super(401, message, { code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenException extends HttpException {
  constructor(message = 'Forbidden') {
    super(403, message, { code: 'FORBIDDEN' });
  }
}

export class NotFoundException extends HttpException {
  constructor(message = 'Resource not found') {
    super(404, message, { code: 'NOT_FOUND' });
  }
}

export class MethodNotAllowedException extends HttpException {
  constructor(message = 'Method not allowed') {
    super(405, message, { code: 'METHOD_NOT_ALLOWED' });
  }
}

export class RequestTimeoutException extends HttpException {
  constructor(message = 'Request timeout') {
    super(408, message, { code: 'REQUEST_TIMEOUT' });
  }
}

export class ConflictException extends HttpException {
  constructor(message = 'Conflict', details?: unknown) {
    super(409, message, { code: 'CONFLICT', details });
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(message = 'Payload too large') {
    super(413, message, { code: 'PAYLOAD_TOO_LARGE' });
  }
}

export class UnsupportedMediaTypeException extends HttpException {
  constructor(message = 'Unsupported media type') {
    super(415, message, { code: 'UNSUPPORTED_MEDIA_TYPE' });
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(message = 'Unprocessable entity', details?: unknown) {
    super(422, message, { code: 'UNPROCESSABLE_ENTITY', details });
  }
}

export class TooManyRequestsException extends HttpException {
  constructor(message = 'Too many requests') {
    super(429, message, { code: 'TOO_MANY_REQUESTS' });
  }
}

export class InternalServerException extends HttpException {
  constructor(message = 'Internal server error', cause?: unknown) {
    super(500, message, {
      code: 'INTERNAL_SERVER_ERROR',
      expose: false,
      cause,
    });
  }
}

export class BadGatewayException extends HttpException {
  constructor(cause?: unknown) {
    super(502, 'Bad gateway', {
      code: 'BAD_GATEWAY',
      expose: true,
      cause,
    });
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(cause?: unknown) {
    super(503, 'Service unavailable', {
      code: 'SERVICE_UNAVAILABLE',
      expose: true,
      cause,
    });
  }
}

export class GatewayTimeoutException extends HttpException {
  constructor(cause?: unknown) {
    super(504, 'Gateway timeout', {
      code: 'GATEWAY_TIMEOUT',
      expose: true,
      cause,
    });
  }
}
