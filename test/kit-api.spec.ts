import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createWrapRoute } from '@/common/http/wrap-route';
import { createErrorHandlerMiddleware } from '@/common/middleware/error-handler.middleware';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { createRequireAuthMiddleware } from '@/modules/auth/auth.middleware';
import { singleton } from '@/common/providers/provider';
import type { PaginateModel } from 'mongoose';
import { KitController } from '@/modules/kit/kit.controller';
import type { Kit, KitDocument } from '@/modules/kit/kit.model';
import { KitRepository } from '@/modules/kit/kit.repository';
import { createKitRouter } from '@/modules/kit/kit.router';
import { KitService } from '@/modules/kit/kit.service';

const USER_A = 'user-a';
const USER_B = 'user-b';
const KIT_A = '0000000000000000000000a1';
const KIT_MISSING = '0000000000000000000000b2';

const silentLogger = (): LoggerService => {
  const requestContext = new RequestContextService();
  return new LoggerService({
    baseLogger: createBaseLogger('silent'),
    requestContext,
  });
};

const kitDoc = (overrides: Record<string, unknown> = {}): KitDocument =>
  ({
    id: KIT_A,
    status: 'queued',
    input: { jd: 'Build things', companyUrl: 'https://acme.test/jobs', days: 5 },
    kit: null,
    idSequences: { requirement: 0, question: 0, flashcard: 0 },
    practiceRecords: [],
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
    ...overrides,
  }) as unknown as KitDocument;

type MockRepository = {
  [K in 'create' | 'findByUserPaginated' | 'findOwnedById' | 'addPracticeRecord']: ReturnType<
    typeof vi.fn
  >;
};

const mockRepository = (): KitRepository & MockRepository =>
  ({
    create: vi.fn(),
    findByUserPaginated: vi.fn(),
    findOwnedById: vi.fn(),
    addPracticeRecord: vi.fn(),
  }) as unknown as KitRepository & MockRepository;

const paginated = (
  docs: KitDocument[],
  pagination: Record<string, number | boolean | null> = {},
): { items: KitDocument[]; pagination: Record<string, number | boolean | null> } => ({
  items: docs,
  pagination: {
    page: 1,
    limit: 20,
    totalItems: docs.length,
    // Mirrors verified mongoose-paginate-v2 behavior: an empty collection
    // reports totalPages 1, and out-of-range pages echo the requested page
    // with empty docs. We pass plugin semantics through, never falsify them.
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
    nextPage: null,
    prevPage: null,
    ...pagination,
  },
});

const withSession =
  (userId?: string): RequestHandler =>
  (req, _res, next): void => {
    (req as { session: unknown }).session = userId ? { userId } : {};
    next();
  };

const buildApp = (repository: KitRepository & MockRepository, userId?: string) => {
  const logger = silentLogger();
  const requestContext = new RequestContextService();
  const kitService = new KitService({ kitRepository: repository, logger });
  const kitController = singleton(() => new KitController({ kitService }));
  const app = express();

  app.use(express.json());
  app.use(withSession(userId));
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

const ownedRepository = (): KitRepository & MockRepository => {
  const repository = mockRepository();
  repository.findByUserPaginated.mockImplementation(async (userId: string) =>
    userId === USER_A ? paginated([kitDoc()]) : paginated([]),
  );
  repository.create.mockImplementation(async () => kitDoc({ id: KIT_A }));
  repository.findOwnedById.mockImplementation(async (userId: string, kitId: string) =>
    userId === USER_A && kitId === KIT_A ? kitDoc() : null,
  );
  repository.addPracticeRecord.mockImplementation(async () => kitDoc());
  return repository;
};

describe('kit router registration and auth', () => {
  it('registers GET /api/kits and serves an authenticated list without a 500', async () => {
    const response = await request(buildApp(ownedRepository(), USER_A)).get('/api/kits');

    expect(response.status).toBe(200);
    expect(response.status).not.toBe(500);
    expect(response.body).toEqual({
      success: true,
      data: { items: expect.any(Array), pagination: expect.any(Object) },
    });
  });

  it('rejects unauthenticated list requests', async () => {
    const response = await request(buildApp(ownedRepository())).get('/api/kits');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it('rejects unauthenticated kit creation', async () => {
    const response = await request(buildApp(ownedRepository()))
      .post('/api/kits')
      .send({ jd: 'Build things', companyUrl: 'https://acme.test/jobs', days: 5 });

    expect(response.status).toBe(401);
  });
});

describe('kit owner scoping', () => {
  it('lists only the current user kits', async () => {
    const repository = ownedRepository();
    const response = await request(buildApp(repository, USER_A)).get('/api/kits');

    expect(repository.findByUserPaginated).toHaveBeenCalledWith(USER_A, { page: 1, limit: 20 });
    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({ id: KIT_A, status: 'queued' });
  });

  it('returns an empty page with valid metadata for a user with no kits', async () => {
    const response = await request(buildApp(ownedRepository(), USER_B)).get('/api/kits');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        items: [],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 0,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
          nextPage: null,
          prevPage: null,
        },
      },
    });
  });

  it('returns the requested second page', async () => {
    const repository = ownedRepository();
    repository.findByUserPaginated.mockResolvedValue(
      paginated([kitDoc({ id: KIT_MISSING })], {
        page: 2,
        limit: 1,
        totalItems: 2,
        totalPages: 2,
        hasNextPage: false,
        hasPrevPage: true,
        nextPage: null,
        prevPage: 1,
      }),
    );
    const response = await request(buildApp(repository, USER_A)).get('/api/kits?page=2&limit=1');

    expect(repository.findByUserPaginated).toHaveBeenCalledWith(USER_A, { page: 2, limit: 1 });
    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.pagination).toMatchObject({
      page: 2,
      limit: 1,
      totalItems: 2,
      totalPages: 2,
      hasPrevPage: true,
      prevPage: 1,
    });
  });

  it('associates created kits with the authenticated user', async () => {
    const repository = ownedRepository();
    const response = await request(buildApp(repository, USER_A)).post('/api/kits').send({
      jd: 'Build things',
      companyUrl: 'https://acme.test/jobs',
      days: 5,
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      success: true,
      data: { kitId: KIT_A, status: 'queued' },
    });
    expect(repository.create).toHaveBeenCalledWith({
      userId: USER_A,
      jd: 'Build things',
      companyUrl: 'https://acme.test/jobs',
      days: 5,
    });
  });

  it('lets owners read their own kit', async () => {
    const response = await request(buildApp(ownedRepository(), USER_A)).get(`/api/kits/${KIT_A}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { id: KIT_A, status: 'queued', kit: null },
    });
  });

  it('does not reveal another user kit', async () => {
    const response = await request(buildApp(ownedRepository(), USER_B)).get(`/api/kits/${KIT_A}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, message: 'Kit not found' });
  });

  it('returns a structured error for a missing kit', async () => {
    const response = await request(buildApp(ownedRepository(), USER_A)).get(
      `/api/kits/${KIT_MISSING}`,
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, message: 'Kit not found' });
  });

  it('rejects malformed kit ids before hitting storage', async () => {
    const repository = ownedRepository();
    const response = await request(buildApp(repository, USER_A)).get('/api/kits/not-an-id');

    expect(response.status).toBe(400);
    expect(repository.findOwnedById).not.toHaveBeenCalled();
  });
});

describe('kit list pagination validation', () => {
  it.each([
    ['page=0', '/api/kits?page=0'],
    ['negative page', '/api/kits?page=-1'],
    ['fractional page', '/api/kits?page=1.5'],
    ['string page', '/api/kits?page=hello'],
    ['limit=0', '/api/kits?limit=0'],
    ['negative limit', '/api/kits?limit=-5'],
    ['limit above max', '/api/kits?limit=101'],
    ['string limit', '/api/kits?limit=hello'],
  ])('rejects %s', async (_name, url) => {
    const repository = ownedRepository();
    const response = await request(buildApp(repository, USER_A)).get(url);

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(repository.findByUserPaginated).not.toHaveBeenCalled();
  });

  it('applies page/limit defaults when omitted', async () => {
    const repository = ownedRepository();
    await request(buildApp(repository, USER_A)).get('/api/kits');

    expect(repository.findByUserPaginated).toHaveBeenCalledWith(USER_A, { page: 1, limit: 20 });
  });

  it('accepts explicit page and limit', async () => {
    const repository = ownedRepository();
    await request(buildApp(repository, USER_A)).get('/api/kits?page=2&limit=10');

    expect(repository.findByUserPaginated).toHaveBeenCalledWith(USER_A, { page: 2, limit: 10 });
  });

  it('rejects unsafe integers before pagination', async () => {
    const service = new KitService({ kitRepository: ownedRepository(), logger: silentLogger() });

    await expect(service.listKits(USER_A, { page: 2 ** 53, limit: 20 })).rejects.toThrow(
      'safe integers',
    );
  });
});

describe('kit repository pagination', () => {
  const repositoryWith = (result: Record<string, unknown>) => {
    const paginate = vi.fn().mockResolvedValue(result);
    const repository = new KitRepository({
      kitModel: { paginate } as unknown as PaginateModel<Kit>,
      logger: silentLogger(),
    });
    return { repository, paginate };
  };

  it('scopes by owner with deterministic sort and normalized output', async () => {
    const { repository, paginate } = repositoryWith({
      docs: [kitDoc()],
      totalDocs: 1,
      limit: 20,
      page: 1,
      totalPages: 1,
      hasPrevPage: false,
      hasNextPage: false,
      prevPage: undefined,
      nextPage: undefined,
      pagingCounter: 1,
    });

    const result = await repository.findByUserPaginated(USER_A, { page: 1, limit: 20 });

    expect(paginate).toHaveBeenCalledWith(
      { userId: USER_A },
      { page: 1, limit: 20, sort: { createdAt: -1, _id: -1 } },
    );
    expect(result.items).toHaveLength(1);
    expect(result.pagination).toEqual({
      page: 1,
      limit: 20,
      totalItems: 1,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
      nextPage: null,
      prevPage: null,
    });
    expect(result).not.toHaveProperty('docs');
    expect(result).not.toHaveProperty('totalDocs');
    expect(result).not.toHaveProperty('pagingCounter');
  });

  it('passes out-of-range plugin pages through unchanged', async () => {
    const { repository } = repositoryWith({
      docs: [],
      totalDocs: 5,
      limit: 2,
      page: 9,
      totalPages: 3,
      hasPrevPage: true,
      hasNextPage: false,
      prevPage: 8,
      nextPage: undefined,
      pagingCounter: 17,
    });

    const result = await repository.findByUserPaginated(USER_A, { page: 9, limit: 2 });

    expect(result.items).toEqual([]);
    expect(result.pagination).toEqual({
      page: 9,
      limit: 2,
      totalItems: 5,
      totalPages: 3,
      hasNextPage: false,
      hasPrevPage: true,
      nextPage: null,
      prevPage: 8,
    });
  });
});

describe('kit creation validation', () => {
  it.each([
    ['missing body', {}],
    ['blank jd', { jd: '   ', companyUrl: 'https://acme.test/jobs', days: 5 }],
    ['bad url', { jd: 'Build things', companyUrl: 'not-a-url', days: 5 }],
    ['zero days', { jd: 'Build things', companyUrl: 'https://acme.test/jobs', days: 0 }],
    ['too many days', { jd: 'Build things', companyUrl: 'https://acme.test/jobs', days: 61 }],
  ])('rejects %s', async (_name, body) => {
    const response = await request(buildApp(ownedRepository(), USER_A))
      .post('/api/kits')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });
});

describe('kit status and practice', () => {
  it('reports truthful queued status for a new kit', async () => {
    const response = await request(buildApp(ownedRepository(), USER_A)).get(
      `/api/kits/${KIT_A}/status`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { kitId: KIT_A, status: 'queued', progress: 0, steps: [] },
    });
  });

  it('records practice against an owned kit', async () => {
    const repository = ownedRepository();
    const response = await request(buildApp(repository, USER_A))
      .patch(`/api/kits/${KIT_A}/practice/f1`)
      .send({ confidence: 4 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { recorded: true } });
    expect(repository.addPracticeRecord).toHaveBeenCalledWith(USER_A, KIT_A, {
      flashcardId: 'f1',
      confidence: 4,
    });
  });

  it('rejects practice on another user kit', async () => {
    const response = await request(buildApp(ownedRepository(), USER_B))
      .patch(`/api/kits/${KIT_A}/practice/f1`)
      .send({ confidence: 4 });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, message: 'Kit not found' });
  });

  it('rejects unknown flashcards once kit content exists', async () => {
    const repository = ownedRepository();
    repository.findOwnedById.mockResolvedValue(kitDoc({ kit: { flashcards: [{ id: 'f1' }] } }));
    const response = await request(buildApp(repository, USER_A))
      .patch(`/api/kits/${KIT_A}/practice/missing`)
      .send({ confidence: 3 });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, message: 'Flashcard not found' });
  });

  it('rejects out-of-range confidence', async () => {
    const response = await request(buildApp(ownedRepository(), USER_A))
      .patch(`/api/kits/${KIT_A}/practice/f1`)
      .send({ confidence: 9 });

    expect(response.status).toBe(400);
  });
});
