import { describe, expect, it, vi } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { validateInterviewKit } from '@/modules/kit/kit.validator';
import { KitService } from '@/modules/kit/kit.service';
import type { InterviewKit } from '@/modules/kit/kit.type';

const silentLogger = (): LoggerService => {
  const requestContext = new RequestContextService();
  return new LoggerService({ baseLogger: createBaseLogger('silent'), requestContext });
};

type IdempotencyEntry = { status: 'processing' | 'completed' | 'failed'; resourceId?: string };

// In-memory idempotency honoring the same contract as the Mongo version:
// unique userId + operation + key, claim loses when a record already exists.
const fakeIdempotency = (entries = new Map<string, IdempotencyEntry>()) => {
  const slot = (userId: string, operation: string, key: string) => `${userId}:${operation}:${key}`;

  return {
    entries,
    find: vi.fn(async (userId: string, operation: string, key: string) => {
      const entry = entries.get(slot(userId, operation, key));
      return entry ? { status: entry.status, resourceId: entry.resourceId } : null;
    }),
    claim: vi.fn(async (userId: string, operation: string, key: string) => {
      const name = slot(userId, operation, key);

      if (entries.has(name)) {
        return { claimed: false as const };
      }

      entries.set(name, { status: 'processing' });
      return { claimed: true as const, record: {} };
    }),
    attachResource: vi.fn(
      async (userId: string, operation: string, key: string, resourceId: string) => {
        const entry = entries.get(slot(userId, operation, key));

        if (entry) {
          entry.resourceId = resourceId;
        }
      },
    ),
    complete: vi.fn(async (userId: string, operation: string, key: string) => {
      entries.get(slot(userId, operation, key))!.status = 'completed';
    }),
    fail: vi.fn(async (userId: string, operation: string, key: string) => {
      entries.get(slot(userId, operation, key))!.status = 'failed';
    }),
  };
};

const completedKit = (): InterviewKit => ({
  source: {
    company: 'Acme',
    company_url: 'https://acme.test',
    role: 'Engineer',
    location: 'Remote',
    jd_chars: 50,
    researched_at: '2026-09-09T00:00:00.000Z',
    pages_used: [],
  },
  company_brief: { summary: 'Summary', what_they_do: 'Widgets', sources: [] },
  role: {
    title: 'Engineer',
    seniority: 'Senior',
    responsibilities: ['Build'],
    requirements: [{ id: 'r1', text: 'TypeScript', kind: 'technical', priority: 'must' }],
  },
  questions: [
    {
      id: 'q1',
      requirement_ids: ['r1'],
      category: 'technical',
      prompt: 'TypeScript?',
      answer_outline: 'Types',
      difficulty: 2,
    },
  ],
  flashcards: [{ id: 'f1', front: 'Type?', back: 'Static', requirement_ids: ['r1'] }],
  schedule: {
    days_available: 1,
    days: [{ day: 1, focus: 'Technical', question_ids: ['q1'], minutes: 30 }],
  },
  coverage: { uncovered_requirement_ids: [], passes: 1 },
});

const buildService = (idempotency: ReturnType<typeof fakeIdempotency>) => {
  let counter = 0;
  const kits = new Map<string, { id: string; status: string; kit: InterviewKit | null }>();
  const create = vi.fn(async (record: { userId: string }) => {
    counter += 1;
    const id = `kit-${counter}`;
    kits.set(id, { id, status: 'queued', kit: null });
    return { id, status: 'queued', userId: record.userId };
  });
  // One completed kit under edit for mutation tests.
  kits.set('kit-0', { id: 'kit-0', status: 'completed', kit: completedKit() });
  const findOwnedById = vi.fn(async (_userId: string, kitId: string) => {
    const kit = kits.get(kitId);

    if (!kit) {
      return null;
    }

    return {
      ...structuredClone(kit),
      input: { jd: 'Build things', companyUrl: 'https://acme.test', days: 1 },
      idSequences: { requirement: 1, question: 1, flashcard: 1 },
      editorMeta: {},
      practiceRecords: [],
    };
  });
  const saveEditedKit = vi.fn(
    async (
      _userId: string,
      kitId: string,
      kit: InterviewKit,
      sequences: { requirement: number; question: number; flashcard: number },
      editorMeta: Record<string, unknown>,
    ) => {
      const current = kits.get(kitId);

      if (!current) {
        return null;
      }

      current.kit = structuredClone(kit);
      void sequences;
      void editorMeta;
      return findOwnedById('user-a', kitId);
    },
  );
  const queueAdd = vi.fn(async () => ({}));
  const generateCategoryQuestions = vi.fn(async () => [
    {
      prompt: 'Fresh technical',
      answer_outline: 'Fresh outline',
      difficulty: 2 as const,
      requirement_ids: ['r1'],
    },
  ]);
  const service = new KitService({
    kitRepository: {
      create,
      findOwnedById,
      saveEditedKit,
      updateGenerationState: vi.fn(async () => ({})),
    } as never,
    idempotency: idempotency as never,
    generationQueue: { add: queueAdd } as never,
    kitGeneration: () => ({
      generateBrief: vi.fn(async () => ({ summary: 'Brief', what_they_do: 'What' })),
      generateCategoryQuestions,
      repairQuestions: vi.fn(async () => []),
      validateEditedKit: validateInterviewKit,
    }),
    research: { researchCompany: vi.fn(async () => emptyResearch()) } as never,
    logger: silentLogger(),
  });

  return { service, create, queueAdd, generateCategoryQuestions };
};

const createInput = { jd: 'Build things', companyUrl: 'https://acme.test', days: 1 };

const emptyResearch = () => ({
  companyUrl: 'https://acme.test',
  companySite: { pages: [] },
  publicDiscussions: { sources: [], companySearchName: null },
  status: 'failed',
  failures: [],
});

describe('create-kit idempotency', () => {
  it('same key twice creates one Kit and enqueues one job', async () => {
    const idempotency = fakeIdempotency();
    const { service, create, queueAdd } = buildService(idempotency);

    const first = await service.createKit('user-a', createInput, 'key-1');
    const second = await service.createKit('user-a', createInput, 'key-1');

    expect(create).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('a lost claim race replays the winner instead of creating again', async () => {
    const idempotency = fakeIdempotency();
    const { service, create } = buildService(idempotency);

    // Simulate the winner having completed under the same key.
    idempotency.entries.set('user-a:create-kit:key-race', {
      status: 'completed',
      resourceId: 'kit-0',
    });

    const result = await service.createKit('user-a', createInput, 'key-race');

    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({ kitId: 'kit-0', status: 'completed' });
  });

  it('identical JD/company with a NEW key creates a NEW kit', async () => {
    const idempotency = fakeIdempotency();
    const { service, create, queueAdd } = buildService(idempotency);

    const first = await service.createKit('user-a', createInput, 'key-1');
    const second = await service.createKit('user-a', createInput, 'key-2');

    expect(create).toHaveBeenCalledTimes(2);
    expect(queueAdd).toHaveBeenCalledTimes(2);
    expect(second.kitId).not.toBe(first.kitId);
  });
});

describe('mutation idempotency', () => {
  it('same regeneration key twice invokes the LLM once', async () => {
    const idempotency = fakeIdempotency();
    const { service, generateCategoryQuestions } = buildService(idempotency);
    const input = { section: 'questions', category: 'technical' } as const;

    await service.regenerate('user-a', 'kit-0', input, 'regen-1');
    const replayed = await service.regenerate('user-a', 'kit-0', input, 'regen-1');

    expect(generateCategoryQuestions).toHaveBeenCalledTimes(1);
    expect(replayed.questions.map((question) => question.prompt)).toContain('Fresh technical');
  });

  it('same add-question key twice creates exactly one question', async () => {
    const idempotency = fakeIdempotency();
    const { service } = buildService(idempotency);
    const input = {
      prompt: 'Manual?',
      answer_outline: 'Manual outline.',
      category: 'technical' as const,
      requirement_ids: ['r1'],
    };

    const first = await service.addQuestion('user-a', 'kit-0', input, 'add-1');
    const second = await service.addQuestion('user-a', 'kit-0', input, 'add-1');

    expect(first.questions).toHaveLength(2);
    expect(second.questions).toHaveLength(2);
    expect(second.questions.filter((question) => question.prompt === 'Manual?')).toHaveLength(1);
  });

  it('same add-flashcard key twice creates exactly one flashcard', async () => {
    const idempotency = fakeIdempotency();
    const { service } = buildService(idempotency);
    const input = { front: 'Manual front', back: 'Manual back', requirement_ids: ['r1'] };

    const first = await service.addFlashcard('user-a', 'kit-0', input, 'card-1');
    const second = await service.addFlashcard('user-a', 'kit-0', input, 'card-1');

    expect(first.flashcards).toHaveLength(2);
    expect(second.flashcards).toHaveLength(2);
    expect(
      second.flashcards.filter((flashcard) => flashcard.front === 'Manual front'),
    ).toHaveLength(1);
  });
});
