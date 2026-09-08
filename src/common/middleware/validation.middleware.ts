import type { RequestHandler } from 'express';
import { validationResult } from 'express-validator';
import { BadRequestException } from '../errors/http-exception';

export const validationMiddleware: RequestHandler = (req, _res, next): void => {
  const result = validationResult(req);

  if (!result.isEmpty()) {
    next(new BadRequestException('Request validation failed', result.array()));
    return;
  }

  next();
};
