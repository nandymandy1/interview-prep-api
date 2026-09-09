import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createWrapRoute } from '@/common/http/wrap-route';
import { createErrorHandlerMiddleware } from '@/common/middleware/error-handler.middleware';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { createRequireAuthMiddleware } from '@/modules/auth/auth.middleware';
import { singleton } from '@/common/providers/provider';
import { KitController } from '@/modules/kit/kit.controller';
import type { KitDocument } from '@/modules/kit/kit.model';
import type { KitRepository } from '@/modules/kit/kit.repository';
import { createKitRouter } from '@/modules/kit/kit.router';
import { KitService } from '@/modules/kit/kit.service';

const USER_A = 'user-a';
const USER_B = 'user-b';
const KIT_A = '0000000000000000000000a1';

const silentLogger = (): LoggerService => {
  const requestContext = new RequestContextService();
  return new LoggerService({
    baseLogger: createBaseLogger('silent'),
    requestContext,
  });
};

// Live kit state behind the mocks: findOwnedById returns the current doc and
// updateGenerationState applies status/stage/error transitions to it.
const statefulKit = (status: string) => {
  const doc = {
    id: KIT_A,
    status,
    input: { jd: 'Build things', companyUrl: 'https://acme.test/jobs', days: 5 },
    kit: null,
    error:
      status === 'failed'
        ? { code: 'OPENAI_RATE_LIMITED', message: 'OpenAI is temporarily rate-limiting.' }
        : undefined,
  } as unknown as KitDocument;

  const findOwnedById = vi.fn(async (userId: string, kitId: string) =>
    userId === USER_A && kitId === KIT_A ? doc : null,
  );
  const updateGenerationState = vi.fn(
    async (_userId: string, _kitId: string, update: Record<string, unknown>) => {
      Object.assign(doc, update);
      return doc;
    },
  );

  return { doc, findOwnedById, updateGenerationState };
};

// Minimal in-memory IdempotencyRepository honoring claim/find/attach/complete
// semantics, including the duplicate-key loss path.
const memoryIdempotency = () => {
  const records = new Map<string, { status: string; resourceId?: string }>();
  const keyOf = (userId: string, operation: string, key: string) => `${userId}:${operation}:${key}`;

  return {
    find: vi.fn(async (userId: string, operation: string, key: string) => {
      const record = records.get(keyOf(userId, operation, key));
      return record ? { ...record } : null;
    }),
    claim: vi.fn(async (userId: string, operation: string, key: string) => {
      const id = keyOf(userId, operation, key);

      if (records.has(id)) {
        return { claimed: false as const };
      }

      records.set(id, { status: 'processing' });
      return { claimed: true as const, record: {} };
    }),
    attachResource: vi.fn(
      async (userId: string, operation: string, key: string, resourceId: string) => {
        const record = records.get(keyOf(userId, operation, key));

        if (record && record.status === 'processing') {
          record.resourceId = resourceId;
        }
      },
    ),
    complete: vi.fn(async (userId: string, operation: string, key: string) => {
      records.get(keyOf(userId, operation, key))!.status = 'completed';
    }),
    fail: vi.fn(async (userId: string, operation: string, key: string) => {
      const record = records.get(keyOf(userId, operation, key));

      if (record && record.status === 'processing') {
        record.status = 'failed';
      }
    }),
  };
};

const withSession =
  (userId?: string): RequestHandler =>
  (req, _res, next): void => {
    (req as { session: unknown }).session = userId ? { userId } : {};
    next();
  };

const buildRetryApp = (harness: {
  findOwnedById: ReturnType<typeof vi.fn>;
  updateGenerationState: ReturnType<typeof vi.fn>;
  queue: { getJob: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };
  idempotency?: ReturnType<typeof memoryIdempotency>;
  userId?: string;
}) => {
  const logger = silentLogger();
  const requestContext = new RequestContextService();
  const kitService = new KitService({
    kitRepository: {
      findOwnedById: harness.findOwnedById,
      updateGenerationState: harness.updateGenerationState,
    } as unknown as KitRepository,
    idempotency: (harness.idempotency ?? memoryIdempotency()) as never,
    generationQueue: harness.queue as never,
    kitGeneration: (() => ({})) as never,
    research: {} as never,
    logger,
  });
  const kitController = singleton(() => new KitController({ kitService }));
  const app = express();

  app.use(express.json());
  app.use(withSession(harness.userId));
  app.use(
    '/api/kits',
    createKitRouter({
      kitController,
      wrapRoute: createWrapRoute({ logger }),
      requireAuth: createRequireAuthMiddleware({ requestContext }),
    }),
  );
  app.use(createErrorHandlerMiddleware(logger));

  return app;
};

const failedHarness = (userId?: string) => {
  const { findOwnedById, updateGenerationState } = statefulKit('failed');
  const remove = vi.fn(async () => undefined);
  const queue = {
    getJob: vi.fn(async (jobId: string) => (jobId === KIT_A ? { remove } : null)),
    add: vi.fn(async () => ({})),
  };

  return {
    app: buildRetryApp({ findOwnedById, updateGenerationState, queue, userId }),
    queue,
    remove,
    updateGenerationState,
  };
};

describe('POST /api/kits/:kitId/retry', () => {
  it('retries a failed kit with the same id and reuses saved inputs', async () => {
    const { app, queue, remove, updateGenerationState } = failedHarness(USER_A);

    const response = await request(app).post(`/api/kits/${KIT_A}/retry`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { kitId: KIT_A, status: 'queued' },
    });
    expect(updateGenerationState).toHaveBeenCalledWith(USER_A, KIT_A, {
      status: 'queued',
      stage: 'queued',
      stageMessage: 'Retry queued.',
      error: null,
    });
    expect(queue.getJob).toHaveBeenCalledWith(KIT_A);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'generate',
      {
        kitId: KIT_A,
        userId: USER_A,
        jd: 'Build things',
        companyUrl: 'https://acme.test/jobs',
        days: 5,
      },
      expect.objectContaining({ jobId: KIT_A, attempts: 1 }),
    );
  });

  it('adds a fresh job when no stale BullMQ job exists', async () => {
    const { findOwnedById, updateGenerationState } = statefulKit('failed');
    const queue = {
      getJob: vi.fn(async () => null),
      add: vi.fn(async () => ({})),
    };
    const app = buildRetryApp({ findOwnedById, updateGenerationState, queue, userId: USER_A });

    const response = await request(app).post(`/api/kits/${KIT_A}/retry`);

    expect(response.status).toBe(200);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('is owner-scoped: another user sees 404 and nothing enqueues', async () => {
    const { app, queue } = failedHarness(USER_B);

    const response = await request(app).post(`/api/kits/${KIT_A}/retry`);

    expect(response.status).toBe(404);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated retries', async () => {
    const { app, queue } = failedHarness();

    const response = await request(app).post(`/api/kits/${KIT_A}/retry`);

    expect(response.status).toBe(401);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([['queued'], ['running'], ['completed']])(
    'rejects retry on %s kits with 409 and enqueues nothing',
    async (status) => {
      const { findOwnedById, updateGenerationState } = statefulKit(status);
      const queue = {
        getJob: vi.fn(async () => null),
        add: vi.fn(async () => ({})),
      };
      const app = buildRetryApp({ findOwnedById, updateGenerationState, queue, userId: USER_A });

      const response = await request(app).post(`/api/kits/${KIT_A}/retry`);

      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
      expect(updateGenerationState).not.toHaveBeenCalled();
    },
  );

  it('coalesces duplicate retry requests under one Idempotency-Key into one job', async () => {
    const { findOwnedById, updateGenerationState } = statefulKit('failed');
    const queue = {
      getJob: vi.fn(async () => null),
      add: vi.fn(async () => ({})),
    };
    const idempotency = memoryIdempotency();
    const app = buildRetryApp({
      findOwnedById,
      updateGenerationState,
      queue,
      idempotency,
      userId: USER_A,
    });
    const key = 'retry-key-1';

    const first = await request(app).post(`/api/kits/${KIT_A}/retry`).set('Idempotency-Key', key);
    const second = await request(app).post(`/api/kits/${KIT_A}/retry`).set('Idempotency-Key', key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, data: { kitId: KIT_A, status: 'queued' } });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed kit ids before hitting storage', async () => {
    const { findOwnedById, updateGenerationState } = statefulKit('failed');
    const queue = {
      getJob: vi.fn(async () => null),
      add: vi.fn(async () => ({})),
    };
    const app = buildRetryApp({ findOwnedById, updateGenerationState, queue, userId: USER_A });

    const response = await request(app).post('/api/kits/not-an-id/retry');

    expect(response.status).toBe(400);
    expect(findOwnedById).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
