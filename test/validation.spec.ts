import express from 'express';
import request from 'supertest';
import { body } from 'express-validator';
import { describe, expect, it } from 'vitest';
import { validationMiddleware } from '@/common/middleware/validation.middleware';
import { createErrorHandlerMiddleware } from '@/common/middleware/error-handler.middleware';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';

describe('validation middleware', () => {
  it('returns a 400 structured error when express-validator rejects input', async () => {
    const requestContext = new RequestContextService();
    const logger = new LoggerService({
      baseLogger: createBaseLogger('silent'),
      requestContext,
    });
    const app = express();

    app.use(express.json());
    app.post('/validate', body('email').isEmail(), validationMiddleware, (_req, res) =>
      res.status(200).json({ success: true }),
    );
    app.use(createErrorHandlerMiddleware(logger));

    const response = await request(app).post('/validate').send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Request validation failed');
    expect(Array.isArray(response.body.details)).toBe(true);
  });
});
