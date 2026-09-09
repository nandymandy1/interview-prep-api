import { describe, expect, it, vi } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { ConflictException } from '@/common/errors/http-exception';
import { validateInterviewKit } from '@/modules/kit/kit.validator';
import { KitRepository } from '@/modules/kit/kit.repository';
import { KitService, KIT_CONFLICT_MESSAGE } from '@/modules/kit/kit.service';
import type { InterviewKit } from '@/modules/kit/kit.type';

const silentLogger = (): LoggerService => {
  const requestContext = new RequestContextService();
  return new LoggerService({ baseLogger: createBaseLogger('silent'), requestContext });
};

const freshNoIdempotency = () => ({
  find: vi.fn(async () => null),
  claim: vi.fn(async () => ({ claimed: true as const, record: {} })),
  complete: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
});

const regenKit = (): InterviewKit => ({
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
    requirements: [
      { id: 'r1', text: 'TypeScript', kind: 'technical', priority: 'must' },
      { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
    ],
  },
  questions: [
    {
      id: 'q1',
      requirement_ids: ['r1'],
      category: 'technical',
      prompt: 'Old technical',
      answer_outline: 'Outline',
      difficulty: 2,
    },
    {
      id: 'q2',
      requirement_ids: ['r2'],
      category: 'behavioural',
      prompt: 'Old behavioural',
      answer_outline: 'Outline',
      difficulty: 2,
    },
  ],
  flashcards: [{ id: 'f1', front: 'Type?', back: 'Static', requirement_ids: ['r1'] }],
  schedule: {
    days_available: 1,
    days: [{ day: 1, focus: 'Technical + Behavioural', question_ids: ['q1', 'q2'], minutes: 60 }],
  },
  coverage: { uncovered_requirement_ids: [], passes: 1 },
});

const regenService = (overrides: {
  generateCategoryQuestions: ReturnType<typeof vi.fn>;
  repairQuestions: ReturnType<typeof vi.fn>;
  saveEditedKit?: ReturnType<typeof vi.fn>;
}) => {
  let current = regenKit();
  const findOwnedById = vi.fn(async () => ({
    id: 'kit',
    status: 'completed',
    input: { jd: 'Build things', companyUrl: 'https://acme.test', days: 1 },
    kit: structuredClone(current),
    idSequences: { requirement: 2, question: 2, flashcard: 1 },
    editorMeta: {},
    practiceRecords: [],
  }));
  const saveEditedKit =
    overrides.saveEditedKit ??
    vi.fn(async (_userId: string, _kitId: string, kit: InterviewKit) => {
      current = structuredClone(kit);
      return { kit: current };
    });
  const service = new KitService({
    kitRepository: { findOwnedById, saveEditedKit } as never,
    idempotency: freshNoIdempotency() as never,
    generationQueue: {} as never,
    kitGeneration: () => ({
      generateBrief: vi.fn(async () => ({ summary: 'Brief', what_they_do: 'What' })),
      generateCategoryQuestions: overrides.generateCategoryQuestions,
      repairQuestions: overrides.repairQuestions,
      validateEditedKit: validateInterviewKit,
    }),
    research: {
      researchCompany: vi.fn(async () => ({
        companyUrl: 'https://acme.test',
        companySite: { pages: [] },
        publicDiscussions: { sources: [], companySearchName: null },
        status: 'failed',
        failures: [],
      })),
    } as never,
    logger: silentLogger(),
  });

  return { service, saveEditedKit, currentKit: () => current };
};

describe('category regeneration coverage repair', () => {
  it('runs one repair pass when a must loses coverage, then saves covered', async () => {
    const repairQuestions = vi.fn(async () => [
      {
        category: 'technical',
        prompt: 'Repair technical',
        answer_outline: 'Repair outline',
        difficulty: 2,
        requirement_ids: ['r1'],
      },
    ]);
    const { service, saveEditedKit } = regenService({
      // Fresh technical questions forget r1: only the repair re-covers it.
      generateCategoryQuestions: vi.fn(async () => [
        {
          prompt: 'Fresh but uncovered',
          answer_outline: 'Outline',
          difficulty: 1,
          requirement_ids: [],
        },
      ]),
      repairQuestions,
    });

    const regenerated = await service.regenerate('user-a', 'kit', {
      section: 'questions',
      category: 'technical',
    });

    expect(repairQuestions).toHaveBeenCalledTimes(1);
    expect(regenerated.coverage.uncovered_requirement_ids).toEqual([]);
    expect(saveEditedKit).toHaveBeenCalledTimes(1);
    expect(() => validateInterviewKit(regenerated)).not.toThrow();
  });

  it('preserves the persisted kit untouched when repair cannot cover a must', async () => {
    const saveEditedKit = vi.fn(async () => {
      throw new Error('must not save a broken regeneration');
    });
    const { service, currentKit } = regenService({
      generateCategoryQuestions: vi.fn(async () => [
        {
          prompt: 'Fresh but uncovered',
          answer_outline: 'Outline',
          difficulty: 1,
          requirement_ids: [],
        },
      ]),
      repairQuestions: vi.fn(async () => []),
      saveEditedKit,
    });

    await expect(
      service.regenerate('user-a', 'kit', { section: 'questions', category: 'technical' }),
    ).rejects.toThrow('kit unchanged');
    expect(saveEditedKit).not.toHaveBeenCalled();
    expect(currentKit().questions.map((question) => question.prompt)).toEqual([
      'Old technical',
      'Old behavioural',
    ]);
  });
});

describe('builder mutation integrity', () => {
  it('deleting the final question yields an honest empty kit', async () => {
    const single = regenKit();
    single.questions = [single.questions[0] as InterviewKit['questions'][number]];
    single.schedule = {
      days_available: 1,
      days: [{ day: 1, focus: 'Technical', question_ids: ['q1'], minutes: 30 }],
    };
    const current = single;
    const findOwnedById = vi.fn(async () => ({
      id: 'kit',
      status: 'completed',
      input: { jd: 'Build things', companyUrl: 'https://acme.test', days: 1 },
      kit: structuredClone(current),
      idSequences: { requirement: 2, question: 1, flashcard: 1 },
      editorMeta: {},
      practiceRecords: [],
    }));
    const service = new KitService({
      kitRepository: {
        findOwnedById,
        saveEditedKit: vi.fn(async (_u: string, _k: string, kit: InterviewKit) => ({ kit })),
      } as never,
      idempotency: freshNoIdempotency() as never,
      generationQueue: {} as never,
      kitGeneration: (() => ({ validateEditedKit: validateInterviewKit })) as never,
      research: {} as never,
      logger: silentLogger(),
    });

    const emptied = await service.deleteQuestion('user-a', 'kit', 'q1');

    expect(emptied.questions).toEqual([]);
    expect(emptied.schedule.days.every((day) => day.question_ids.length === 0)).toBe(true);
    expect(() => validateInterviewKit(emptied)).not.toThrow();
  });

  it('repeating an exact reorder leaves the same stable state', async () => {
    const seen: string[][] = [];
    let current = regenKit();
    const findOwnedById = vi.fn(async () => ({
      id: 'kit',
      status: 'completed',
      input: { jd: 'Build things', companyUrl: 'https://acme.test', days: 1 },
      kit: structuredClone(current),
      idSequences: { requirement: 2, question: 2, flashcard: 1 },
      editorMeta: {},
      practiceRecords: [],
    }));
    const service = new KitService({
      kitRepository: {
        findOwnedById,
        saveEditedKit: vi.fn(async (_u: string, _k: string, kit: InterviewKit) => {
          current = structuredClone(kit);
          return { kit: current };
        }),
      } as never,
      idempotency: freshNoIdempotency() as never,
      generationQueue: {} as never,
      kitGeneration: (() => ({ validateEditedKit: validateInterviewKit })) as never,
      research: {} as never,
      logger: silentLogger(),
    });

    const order = { questionIds: ['q2', 'q1'] };
    const first = await service.reorderQuestions('user-a', 'kit', order);
    const second = await service.reorderQuestions('user-a', 'kit', order);

    seen.push(first.questions.map((question) => question.id));
    seen.push(second.questions.map((question) => question.id));
    expect(seen[0]).toEqual(['q2', 'q1']);
    expect(seen[1]).toEqual(['q2', 'q1']);
  });

  it('a stale concurrent save becomes a 409 conflict, never a silent clobber', async () => {
    const service = new KitService({
      kitRepository: {
        findOwnedById: vi.fn(async () => ({
          id: 'kit',
          status: 'completed',
          input: { jd: 'Build things', companyUrl: 'https://acme.test', days: 1 },
          kit: regenKit(),
          idSequences: { requirement: 2, question: 2, flashcard: 1 },
          editorMeta: {},
          practiceRecords: [],
        })),
        saveEditedKit: vi.fn(async () => null),
      } as never,
      idempotency: freshNoIdempotency() as never,
      generationQueue: {} as never,
      kitGeneration: (() => ({ validateEditedKit: validateInterviewKit })) as never,
      research: {} as never,
      logger: silentLogger(),
    });

    const failure = await service
      .updateBrief('user-a', 'kit', { summary: 'Stale edit' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).message).toBe(KIT_CONFLICT_MESSAGE);
  });

  it('versioned saves carry the read version into the write filter', async () => {
    const findOneAndUpdate = vi.fn(async () => ({}));
    const repository = new KitRepository({
      kitModel: { findOneAndUpdate } as never,
      logger: silentLogger(),
    });

    await repository.saveEditedKit(
      'user-a',
      'kit',
      regenKit(),
      { requirement: 0, question: 0, flashcard: 0 },
      {},
      7,
    );

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'kit', userId: 'user-a', __v: 7 },
      expect.objectContaining({ $inc: { __v: 1 } }),
      { new: true },
    );
  });
});

describe('practice SET semantics', () => {
  // Minimal fake honoring just the two filter shapes the repository uses:
  // positional update by flashcardId, or guarded push when absent.
  const fakeKitModel = () => {
    const docs = new Map<
      string,
      { practiceRecords: { flashcardId: string; confidence: number; recordedAt: Date }[] }
    >();
    docs.set('kit', { practiceRecords: [] });

    const findOneAndUpdate = vi.fn(
      async (filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>) => {
        const doc = docs.get(filter._id as string);

        if (!doc) {
          return null;
        }

        const positional = filter['practiceRecords.flashcardId'];

        if (typeof positional === 'string') {
          const record = doc.practiceRecords.find((entry) => entry.flashcardId === positional);

          if (!record) {
            return null;
          }

          record.confidence = update.$set?.['practiceRecords.$.confidence'] as number;
          record.recordedAt = update.$set?.['practiceRecords.$.recordedAt'] as Date;
          return { ...doc };
        }

        const guard = positional as { $ne?: string } | undefined;

        if (guard?.$ne) {
          if (doc.practiceRecords.some((entry) => entry.flashcardId === guard.$ne)) {
            return null;
          }

          doc.practiceRecords.push(
            update.$push?.practiceRecords as {
              flashcardId: string;
              confidence: number;
              recordedAt: Date;
            },
          );
          return { ...doc };
        }

        return null;
      },
    );

    return { docs, findOneAndUpdate };
  };

  it('repeating the same confidence PATCH keeps exactly one logical record', async () => {
    const model = fakeKitModel();
    const repository = new KitRepository({
      kitModel: model as never,
      logger: silentLogger(),
    });

    await repository.setPracticeConfidence('user-a', 'kit', { flashcardId: 'f1', confidence: 3 });
    await repository.setPracticeConfidence('user-a', 'kit', { flashcardId: 'f1', confidence: 3 });
    await repository.setPracticeConfidence('user-a', 'kit', { flashcardId: 'f1', confidence: 5 });

    const records = model.docs.get('kit')?.practiceRecords ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ flashcardId: 'f1', confidence: 5 });
  });
});
