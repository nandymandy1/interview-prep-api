import type { Response } from 'express';
import { HttpException, InternalServerException } from './http-exception';

export type ApiErrorResponse = {
  success: false;
  message: string;
  details?: unknown;
};

type StatusLikeError = {
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
};

export const normalizeHttpException = (error: unknown): HttpException => {
  if (error instanceof HttpException) {
    return error;
  }

  if (isStatusLikeError(error)) {
    const candidateStatus =
      typeof error.statusCode === 'number' ? error.statusCode : error.status;

    if (
      typeof candidateStatus === 'number' &&
      Number.isInteger(candidateStatus) &&
      candidateStatus >= 400 &&
      candidateStatus <= 599
    ) {
      const expose = candidateStatus < 500;
      const message =
        expose && typeof error.message === 'string' && error.message.trim()
          ? error.message
          : 'Internal server error';

      return new HttpException(candidateStatus, message, {
        code: 'HTTP_ERROR',
        expose,
        cause: error,
      });
    }
  }

  return new InternalServerException('Internal server error', error);
};

export const sendErrorResponse = (res: Response, error: unknown): Response => {
  const exception = normalizeHttpException(error);
  const message = exception.expose ? exception.message : 'Internal server error';

  const payload: ApiErrorResponse = {
    success: false,
    message,
  };

  if (exception.expose && exception.details !== undefined) {
    payload.details = exception.details;
  }

  return res.status(exception.statusCode).json(payload);
};

const isStatusLikeError = (error: unknown): error is StatusLikeError =>
  typeof error === 'object' && error !== null;
