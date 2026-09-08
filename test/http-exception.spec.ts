import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@/common/errors/http-exception';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { createWrapRoute } from '@/common/http/wrap-route';
import { singleton } from '@/common/providers/provider';

class TestController {
  async fail(): Promise<void> {
    throw new BadRequestException('your error message goes here');
  }
}

describe('wrapRoute error handling', () => {
  it('maps typed exceptions to the expected status and response shape', async () => {
    const requestContext = new RequestContextService();
    const logger = new LoggerService({
      baseLogger: createBaseLogger('silent'),
      requestContext,
    });
    const wrapRoute = createWrapRoute({ logger });
    const controller = singleton(() => new TestController());
    const app = express();

    app.get('/boom', wrapRoute(controller, 'fail', 'test.fail'));

    const response = await request(app).get('/boom');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      message: 'your error message goes here',
    });
  });
});

class InternalFailureController {
  async fail(): Promise<void> {
    throw new Error('database password leaked here');
  }
}

describe('wrapRoute internal error handling', () => {
  it('does not expose unknown internal error messages', async () => {
    const requestContext = new RequestContextService();
    const logger = new LoggerService({
      baseLogger: createBaseLogger('silent'),
      requestContext,
    });
    const wrapRoute = createWrapRoute({ logger });
    const controller = singleton(() => new InternalFailureController());
    const app = express();

    app.get('/internal-boom', wrapRoute(controller, 'fail', 'test.internal-fail'));

    const response = await request(app).get('/internal-boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      message: 'Internal server error',
    });
  });
});
