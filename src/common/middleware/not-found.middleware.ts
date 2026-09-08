import type { RequestHandler } from 'express';
import { NotFoundException } from '@/common/errors/http-exception';

export const notFoundMiddleware: RequestHandler = (req, _res, next): void => {
  next(new NotFoundException(`Route ${req.method} ${req.originalUrl} not found`));
};
