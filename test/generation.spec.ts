import { describe, expect, it, vi } from 'vitest';
import { RequestContextService } from '@/common/context/request-context.service';
import { createBaseLogger, LoggerService } from '@/infrastructure/logger/logger.service';
import { validateFinalInterviewKit, validateInterviewKit } from '@/modules/kit/kit.validator';
import { KitService } from '@/modules/kit/kit.service';
import { KitGenerationService } from '@/modules/generation/kit-generation.service';
import { runGenerationJob } from '@/modules/generation/kit-generation.processor';
import { runEvaluation } from '@/eval/evaluate';
import { BraveSearchProvider } from '@/modules/research/search/brave-search.provider';
import { InProcessBraveGate } from '@/modules/research/search/brave-gate';
import type { CompanyResearchResult } from '@/modules/research/company-research.service';
import type { InterviewKit } from '@/modules/kit/kit.type';

const silentLogger = (): LoggerService => {
  const requestContext = new RequestContextService();
  return new LoggerService({ baseLogger: createBaseLogger('silent'), requestContext });
};

const pageContent = (title: string, text: string) => ({
  title,
  description: null,
  headings: [],
  text,
  textChars: text.length,
  truncated: false,
  contentEmpty: false,
  contentHash: 'hash',
  trust: 'external-untrusted' as const,
});

const fakeResearchResult = (): CompanyResearchResult =>
  ({
    companyUrl: 'https://acme.test',
    companySite: {
      seedUrl: 'https://acme.test',
      finalSeedUrl: 'https://acme.test',
      pages: [
        {
          requestedUrl: 'https://acme.test',
          finalUrl: 'https://acme.test',
          depth: 0,
          discoveredFrom: null,
          status: 200,
          contentType: 'text/html',
          content: pageContent(
            'Acme Corp',
            'Acme builds widgets. Quantum blockchain synergy team.',
          ),
          relevanceScore: 1,
        },
      ],
      failures: [],
      skipped: [],
      rankedLinks: [],
      truncated: false,
      truncationReasons: [],
      robots: [],
      stats: { pageRequestsAttempted: 1, pagesSucceeded: 1, pagesFailed: 0, pagesSkipped: 0 },
    },
    publicDiscussions: {
      companySearchName: 'Acme',
      queries: ['Acme interview'],
      sources: [
        {
          title: 'Acme interview loop',
          url: 'https://forum.test/acme',
          domain: 'forum.test',
          trust: 'external-untrusted',
          search: { query: 'Acme interview', rank: 0, snippet: 'Tough but fair system design.' },
          fetchStatus: 'not-attempted',
        },
      ],
      failures: [],
      status: 'partial',
      stats: {
        queriesAttempted: 1,
        searchResultsFound: 1,
        uniqueResults: 1,
        pagesAttempted: 0,
        pagesFetched: 0,
        pagesSkipped: 0,
        pagesFailed: 0,
      },
    },
    status: 'partial',
    failures: [],
  }) as unknown as CompanyResearchResult;

const extractionFixture = {
  title: 'Backend Engineer',
  seniority: 'Senior',
  location: 'Remote',
  responsibilities: ['Build Node.js APIs'],
  requirements: [
    { text: 'Build Node.js APIs', kind: 'technical', priority: 'must' },
    { text: 'Mentor junior engineers', kind: 'behavioural', priority: 'must' },
  ],
};

const briefFixture = {
  brief: { summary: 'Acme builds widgets.', what_they_do: 'Widgets for everyone.' },
  flashcards: [
    { front: 'What does Acme do?', back: 'Widgets.', requirement_ids: ['r1'] },
    { front: 'How to mentor?', back: 'Pair often.', requirement_ids: ['r2'] },
  ],
};

const categoryFixture = (category: string, coverBoth: boolean) => ({
  questions: [
    {
      prompt: `${category} question one`,
      answer_outline: 'Outline one.',
      difficulty: 2,
      requirement_ids: ['r1'],
    },
    ...(coverBoth
      ? [
          {
            prompt: `${category} question two`,
            answer_outline: 'Outline two.',
            difficulty: 1,
            requirement_ids: ['r2'],
          },
        ]
      : []),
  ],
});

const repairFixture = {
  questions: [
    {
      category: 'behavioural',
      prompt: 'Mentoring repair question',
      answer_outline: 'Repair outline.',
      difficulty: 2,
      requirement_ids: ['r2'],
    },
  ],
};

// Routes every LLM call by prompt shape so tests assert the real sequence:
// extraction → brief/flashcards → four separate categories → optional repair.
const scriptGemini = (coverBoth: boolean) => {
  const calls: string[] = [];
  const generateJson = vi.fn(async (request: { systemPrompt: string; userPrompt: string }) => {
    const prompt = `${request.systemPrompt}\n\n${request.userPrompt}`;
    if (prompt.includes('Extract the hiring signal')) {
      calls.push('extraction');
      return extractionFixture;
    }

    if (prompt.includes('company brief from the evidence')) {
      calls.push('brief');
      return briefFixture;
    }

    if (prompt.includes('no interview question yet')) {
      calls.push('repair');
      return repairFixture;
    }

    const match = prompt.match(/Write (\S+) interview questions/);
    calls.push(`category:${match?.[1] ?? '?'}`);
    return categoryFixture(match?.[1] ?? 'technical', coverBoth);
  });

  return { calls, generateJson };
};

const generationInput = (days: number) => ({
  jd: 'We need a senior backend engineer to build Node.js APIs and mentor junior engineers.',
  companyUrl: 'https://acme.test',
  days,
  mode: 'evaluation' as const,
});

const buildGeneration = (coverBoth: boolean) => {
  const script = scriptGemini(coverBoth);
  const generation = new KitGenerationService({
    research: { researchCompany: vi.fn(async () => fakeResearchResult()) },
    llm: { provider: 'gemini', generateJson: script.generateJson } as never,
    logger: silentLogger(),
  });

  return { generation, script };
};

describe('kit generation pipeline', () => {
  it('produces a canonical valid kit with exact-day schedule', async () => {
    const { generation } = buildGeneration(true);
    const { kit } = await generation.generate(generationInput(3));

    expect(() => validateFinalInterviewKit(kit)).not.toThrow();
    expect(kit.coverage.uncovered_requirement_ids).toEqual([]);
    expect(kit.schedule.days_available).toBe(3);
    expect(kit.schedule.days).toHaveLength(3);
    expect(new Set(kit.questions.map((question) => question.category))).toEqual(
      new Set(['technical', 'behavioural', 'system-design', 'company-fit']),
    );
  });

  it('takes requirements from the JD only, never from research', async () => {
    const { generation } = buildGeneration(true);
    const { kit } = await generation.generate(generationInput(3));

    expect(kit.role.requirements.map((requirement) => requirement.text)).toEqual([
      'Build Node.js APIs',
      'Mentor junior engineers',
    ]);
  });

  it('generates the four categories in separate calls', async () => {
    const { generation, script } = buildGeneration(true);
    await generation.generate(generationInput(3));

    expect(script.calls.filter((call) => call.startsWith('category:'))).toEqual([
      'category:technical',
      'category:behavioural',
      'category:system-design',
      'category:company-fit',
    ]);
  });

  it('runs exactly one repair pass for uncovered musts', async () => {
    const { generation, script } = buildGeneration(false);
    const { kit } = await generation.generate(generationInput(3));

    expect(script.calls.filter((call) => call === 'repair')).toHaveLength(1);
    expect(kit.coverage.uncovered_requirement_ids).toEqual([]);
    expect(kit.coverage.passes).toBe(2);
    expect(() => validateFinalInterviewKit(kit)).not.toThrow();
  });

  it('passes exact days through to the schedule (1 and 60)', async () => {
    const one = buildGeneration(true);
    const sixty = buildGeneration(true);

    const first = await one.generation.generate(generationInput(1));
    const second = await sixty.generation.generate(generationInput(60));

    expect(first.kit.schedule.days_available).toBe(1);
    expect(first.kit.schedule.days).toHaveLength(1);
    expect(second.kit.schedule.days_available).toBe(60);
    expect(second.kit.schedule.days).toHaveLength(60);
  });

  it('produces an honest thin kit without inventing requirements', async () => {
    const generateJson = vi.fn(async (request: { systemPrompt: string; userPrompt: string }) => {
      const prompt = `${request.systemPrompt}\n\n${request.userPrompt}`;

      if (prompt.includes('Extract the hiring signal')) {
        return { ...extractionFixture, requirements: [] };
      }

      if (prompt.includes('company brief from the evidence')) {
        return {
          brief: briefFixture.brief,
          flashcards: [],
        };
      }

      return { questions: [] };
    });
    const generation = new KitGenerationService({
      research: { researchCompany: vi.fn(async () => fakeResearchResult()) },
      llm: { provider: 'openai', generateJson } as never,
      logger: silentLogger(),
    });

    const { kit } = await generation.generate({
      jd: 'Backend Engineer. Join our team.',
      companyUrl: 'https://acme.test',
      days: 3,
      mode: 'evaluation' as const,
    });

    expect(() => validateFinalInterviewKit(kit)).not.toThrow();
    expect(kit.role.requirements).toEqual([]);
    expect(kit.coverage).toEqual({ uncovered_requirement_ids: [], passes: 1 });
    expect(kit.schedule.days_available).toBe(3);
    expect(kit.schedule.days).toHaveLength(3);
    expect(
      kit.schedule.days.every(
        (day) =>
          day.question_ids.length === 0 &&
          day.minutes === 0 &&
          day.focus === 'Review available role and company context',
      ),
    ).toBe(true);
  });
});

describe('evaluator', () => {
  it('writes the exact Appendix B envelope (id, kit, error:null)', async () => {
    const kit = { id: 'kit' } as unknown as InterviewKit;
    const generate = { generate: vi.fn(async () => ({ kit, sequences: {} as never })) };

    const report = await runEvaluation(
      [{ id: 'case-01', jd: 'Build things.', company_url: 'https://acme.test', days: 2 }],
      generate,
    );

    expect(report.version).toBe('1.0');
    expect(typeof report.generated_at).toBe('string');
    expect(report.kits).toEqual([{ id: 'case-01', status: 'ok', kit, error: null }]);
    // The external contract uses company_url (mapped internally to companyUrl).
    expect(generate.generate).toHaveBeenCalledWith(
      expect.objectContaining({ companyUrl: 'https://acme.test' }),
    );
  });

  it('continues after a failed case with kit:null and an error object', async () => {
    const kit = { id: 'kit' } as unknown as InterviewKit;
    const generate = {
      generate: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ kit, sequences: {} as never }),
    };

    const report = await runEvaluation(
      [
        { id: 'case-01', jd: 'x', company_url: 'https://acme.test' },
        { id: 'case-02', jd: 'y', company_url: 'https://acme.test' },
      ],
      generate,
    );

    expect(report.kits[0]).toMatchObject({
      id: 'case-01',
      status: 'failed',
      kit: null,
      error: { code: 'EVALUATION_CASE_FAILED', message: 'boom' },
    });
    expect(report.kits[1]).toMatchObject({ id: 'case-02', status: 'ok', error: null });
  });
});

describe('generation job runner', () => {
  const jobData = {
    kitId: '0000000000000000000000a1',
    userId: 'user-a',
    jd: 'Build Node.js APIs.',
    companyUrl: 'https://acme.test',
    days: 3,
  };

  const runnerDeps = (generate: ReturnType<typeof vi.fn>) => {
    const updateGenerationState = vi.fn(async () => null);
    const saveGeneratedKit = vi.fn(async () => null);
    const published: Array<{ kitId: string; stage: string; message: string }> = [];

    return {
      deps: {
        kitRepository: { updateGenerationState, saveGeneratedKit },
        generation: { generate },
        publish: vi.fn(async (event: { kitId: string; stage: string; message: string }) => {
          published.push(event);
        }),
        logger: silentLogger(),
      },
      updateGenerationState,
      saveGeneratedKit,
      published,
    };
  };

  it('persists the completed kit and emits progress', async () => {
    const kit = { id: 'kit' } as unknown as InterviewKit;
    const sequences = { requirement: 2, question: 8, flashcard: 2 };
    const generate = vi.fn(
      async (input: { onProgress?: (stage: never, message: string) => Promise<void> }) => {
        await input.onProgress?.('generating' as never, 'Generating.');
        return { kit, sequences };
      },
    );
    const { deps, updateGenerationState, saveGeneratedKit, published } = runnerDeps(generate);

    await runGenerationJob(jobData, deps);

    expect(saveGeneratedKit).toHaveBeenCalledWith('user-a', jobData.kitId, kit, sequences);
    expect(updateGenerationState).toHaveBeenCalledWith(
      'user-a',
      jobData.kitId,
      expect.objectContaining({ stage: 'researching' }),
    );
    expect(published.map((event) => event.stage)).toEqual([
      'researching',
      'generating',
      'completed',
    ]);
  });

  it('persists a safe failed status and rethrows', async () => {
    const generate = vi.fn(async () => {
      throw new Error('LLM exploded');
    });
    const { deps, updateGenerationState, saveGeneratedKit, published } = runnerDeps(generate);

    await expect(runGenerationJob(jobData, deps)).rejects.toThrow('LLM exploded');
    expect(saveGeneratedKit).not.toHaveBeenCalled();
    expect(updateGenerationState).toHaveBeenCalledWith(
      'user-a',
      jobData.kitId,
      expect.objectContaining({
        status: 'failed',
        error: { code: 'GENERATION_FAILED', message: 'LLM exploded' },
      }),
    );
    expect(published.at(-1)).toMatchObject({ stage: 'failed' });
  });
});

describe('brave request gate', () => {
  it('keeps request starts at least 600ms apart', async () => {
    const gate = new InProcessBraveGate();
    const startedAt = Date.now();

    await gate.waitForSlot();
    await gate.waitForSlot();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(599);
  });

  it('gates retries too', async () => {
    const waitForSlot = vi.fn(async () => undefined);
    let calls = 0;
    const provider = new BraveSearchProvider({
      apiKey: 'key',
      gate: { waitForSlot },
      logger: silentLogger(),
      httpGet: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? { status: 429, headers: {}, data: {} }
          : {
              status: 200,
              headers: {},
              data: { web: { results: [{ title: 'T', url: 'https://x.test', description: 'D' }] } },
            };
      }),
    });

    const results = await provider.search({ query: 'acme interview', limit: 5 });

    expect(results).toHaveLength(1);
    expect(waitForSlot).toHaveBeenCalledTimes(2);
  });
});

const completedKit = (): InterviewKit =>
  ({
    source: {
      company: 'Acme',
      company_url: 'https://acme.test',
      role: 'Backend Engineer',
      location: 'Remote',
      jd_chars: 10,
      researched_at: '2026-09-09T00:00:00.000Z',
      pages_used: ['https://acme.test'],
    },
    company_brief: {
      summary: 'Acme builds widgets.',
      what_they_do: 'Widgets.',
      sources: ['https://acme.test'],
    },
    role: {
      title: 'Backend Engineer',
      seniority: 'Senior',
      responsibilities: ['Build APIs'],
      requirements: [
        { id: 'r1', text: 'Build Node.js APIs', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentor juniors', kind: 'behavioural', priority: 'nice' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'Edited prompt',
        answer_outline: 'Outline',
        difficulty: 2,
      },
      {
        id: 'q2',
        requirement_ids: ['r2'],
        category: 'behavioural',
        prompt: 'Old behavioural',
        answer_outline: 'Outline',
        difficulty: 1,
      },
    ],
    flashcards: [{ id: 'f1', front: 'Front', back: 'Back', requirement_ids: ['r1'] }],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: 'Technical', question_ids: ['q1'], minutes: 30 },
        { day: 2, focus: 'Behavioural', question_ids: ['q2'], minutes: 30 },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  }) as InterviewKit;

type FakeDoc = {
  id: string;
  status: string;
  input: { jd: string; companyUrl: string; days: number };
  kit: InterviewKit | null;
  idSequences: { requirement: number; question: number; flashcard: number };
  editorMeta: Record<string, unknown>;
  practiceRecords: never[];
  createdAt: Date;
  updatedAt: Date;
};

const completedDoc = (overrides: Record<string, unknown> = {}): FakeDoc =>
  ({
    id: '0000000000000000000000a1',
    status: 'completed',
    input: { jd: 'Build APIs.', companyUrl: 'https://acme.test', days: 2 },
    kit: completedKit(),
    idSequences: { requirement: 2, question: 2, flashcard: 1 },
    editorMeta: {},
    practiceRecords: [],
    createdAt: new Date('2026-09-09T00:00:00.000Z'),
    updatedAt: new Date('2026-09-09T00:00:00.000Z'),
    ...overrides,
  }) as FakeDoc;

describe('builder preservation', () => {
  const builderService = (
    overrides: {
      generateBrief?: ReturnType<typeof vi.fn>;
      generateCategoryQuestions?: ReturnType<typeof vi.fn>;
    } = {},
  ) => {
    // Stateful fake: edits persist across calls like Mongo would.
    let current = completedDoc();
    const findOwnedById = vi.fn(async () => structuredClone(current));
    const saveEditedKit = vi.fn(
      async (
        _userId: string,
        _kitId: string,
        kit: InterviewKit,
        sequences: { requirement: number; question: number; flashcard: number },
        editorMeta: Record<string, unknown>,
      ) => {
        current = { ...current, kit, idSequences: sequences, editorMeta } as never;
        return structuredClone(current);
      },
    );
    const service = new KitService({
      kitRepository: {
        findOwnedById,
        saveEditedKit,
        updateGenerationState: vi.fn(),
      } as never,
      idempotency: {
        find: vi.fn(async () => null),
        claim: vi.fn(async () => ({ claimed: true as const, record: {} })),
        complete: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
      } as never,
      generationQueue: {} as never,
      kitGeneration: () => ({
        generateBrief:
          overrides.generateBrief ??
          vi.fn(async () => ({ summary: 'Fresh summary', what_they_do: 'Fresh what' })),
        generateCategoryQuestions:
          overrides.generateCategoryQuestions ??
          vi.fn(async () => [
            {
              prompt: 'Fresh technical',
              answer_outline: 'Fresh outline',
              difficulty: 2,
              requirement_ids: ['r1'],
            },
          ]),
        repairQuestions: vi.fn(async () => []),
        validateEditedKit: validateInterviewKit,
      }),
      research: { researchCompany: vi.fn(async () => fakeResearchResult()) },
      logger: silentLogger(),
    });

    return { service, saveEditedKit };
  };

  it('keeps an edited question through category regeneration', async () => {
    const { service } = builderService();

    // Editing marks the question edited + pinned.
    const edited = await service.updateQuestion('user-a', 'kit', 'q1', { prompt: 'My edit' });
    expect(edited.questions.find((question) => question.id === 'q1')?.prompt).toBe('My edit');

    const regenerated = await service.regenerate('user-a', 'kit', {
      section: 'questions',
      category: 'technical',
    });
    const prompts = regenerated.questions.map((question) => question.prompt);

    // Edited q1 survives; only the untouched technical question is replaced.
    expect(prompts).toContain('My edit');
    expect(prompts).toContain('Fresh technical');
    expect(prompts).toContain('Old behavioural');
    expect(prompts).not.toContain('Edited prompt');
    // New IDs continue the high-water sequence (q3), never reused.
    expect(
      regenerated.questions.find((question) => question.prompt === 'Fresh technical')?.id,
    ).toBe('q3');
  });

  it('keeps an edited brief field through brief regeneration', async () => {
    const { service } = builderService();

    await service.updateBrief('user-a', 'kit', { summary: 'My summary' });
    const regenerated = await service.regenerate('user-a', 'kit', { section: 'company_brief' });

    expect(regenerated.company_brief.summary).toBe('My summary');
    expect(regenerated.company_brief.what_they_do).toBe('Fresh what');
  });
});

describe('practice guard', () => {
  it('rejects practice on an incomplete kit', async () => {
    const service = new KitService({
      kitRepository: {
        findOwnedById: vi.fn(async () => completedDoc({ status: 'queued', kit: null })),
      } as never,
      idempotency: {
        find: vi.fn(async () => null),
        claim: vi.fn(async () => ({ claimed: true as const, record: {} })),
        complete: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
      } as never,
      generationQueue: {} as never,
      kitGeneration: (() => ({})) as never,
      research: {} as never,
      logger: silentLogger(),
    });

    await expect(service.recordPractice('user-a', 'kit', 'f1', 4)).rejects.toThrow('not ready');
  });
});

describe('thin-jd determinism', () => {
  const thinGeneration = () => {
    const calls: string[] = [];
    const generateJson = vi.fn(async (request: { systemPrompt: string; userPrompt: string }) => {
      const prompt = `${request.systemPrompt}\n\n${request.userPrompt}`;

      if (prompt.includes('Extract the hiring signal')) {
        calls.push('extraction');
        return { ...extractionFixture, requirements: [] };
      }

      if (prompt.includes('company brief from the evidence')) {
        calls.push('brief');
        return { brief: briefFixture.brief, flashcards: [] };
      }

      calls.push(`unexpected:${prompt.slice(0, 40)}`);
      return { questions: [] };
    });

    const generation = new KitGenerationService({
      research: { researchCompany: vi.fn(async () => fakeResearchResult()) },
      llm: { provider: 'openai', generateJson } as never,
      logger: silentLogger(),
    });

    return { generation, calls };
  };

  it('two-line JD with no requirements makes zero category calls', async () => {
    const { generation, calls } = thinGeneration();

    const { kit } = await generation.generate({
      jd: 'Backend Engineer.\nJoin our team.',
      companyUrl: 'https://acme.test',
      days: 2,
      mode: 'evaluation' as const,
    });

    expect(calls).toEqual(['extraction', 'brief']);
    expect(kit.questions).toEqual([]);
    expect(kit.flashcards).toEqual([]);
    expect(kit.coverage).toEqual({ uncovered_requirement_ids: [], passes: 1 });
    expect(kit.schedule.days).toHaveLength(2);
    expect(() => validateFinalInterviewKit(kit)).not.toThrow();
  });

  it('flashcard prompt carries the requirement id to text mapping', async () => {
    const seen: string[] = [];
    const generateJson = vi.fn(async (request: { systemPrompt: string; userPrompt: string }) => {
      const prompt = `${request.systemPrompt}\n\n${request.userPrompt}`;

      if (prompt.includes('Extract the hiring signal')) {
        return extractionFixture;
      }

      if (prompt.includes('company brief from the evidence')) {
        seen.push(prompt);
        return briefFixture;
      }

      if (prompt.includes('no interview question yet')) {
        return repairFixture;
      }

      return categoryFixture('technical', true);
    });
    const generation = new KitGenerationService({
      research: { researchCompany: vi.fn(async () => fakeResearchResult()) },
      llm: { provider: 'openai', generateJson } as never,
      logger: silentLogger(),
    });

    await generation.generate(generationInput(2));

    expect(seen).toHaveLength(1);
    const briefPrompt = seen[0] as string;
    expect(briefPrompt).toContain('r1 [must][technical]: Build Node.js APIs');
    expect(briefPrompt).toContain('r2 [must][behavioural]: Mentor junior engineers');
  });
});

describe('exact-input generation cache', () => {
  const fakeCache = () => {
    const entries = new Map<string, { content: never }>();
    return {
      findFresh: vi.fn(async (fingerprint: string) => entries.get(fingerprint) ?? null),
      upsert: vi.fn(async (input: { fingerprint: string; content: never }) => {
        entries.set(input.fingerprint, { content: input.content });
      }),
    };
  };

  it('hit skips research and LLM calls and rebuilds the schedule for new days', async () => {
    const script = scriptGemini(true);
    const researchCompany = vi.fn(async () => fakeResearchResult());
    const cache = fakeCache();
    const build = () =>
      new KitGenerationService({
        research: { researchCompany },
        llm: { provider: 'gemini', generateJson: script.generateJson } as never,
        cache: cache as never,
        logger: silentLogger(),
      });

    const first = await build().generate(generationInput(3));
    expect(first.kit.schedule.days).toHaveLength(3);
    expect(cache.upsert).toHaveBeenCalledTimes(1);

    researchCompany.mockClear();
    script.generateJson.mockClear();

    const second = await build().generate({ ...generationInput(5) });

    expect(researchCompany).not.toHaveBeenCalled();
    expect(script.generateJson).not.toHaveBeenCalled();
    // Same pristine material, new exact-day schedule.
    expect(second.kit.questions).toEqual(first.kit.questions);
    expect(second.kit.flashcards).toEqual(first.kit.flashcards);
    expect(second.kit.role.requirements).toEqual(first.kit.role.requirements);
    expect(second.kit.schedule.days_available).toBe(5);
    expect(second.kit.schedule.days).toHaveLength(5);
    expect(() => validateFinalInterviewKit(second.kit)).not.toThrow();
  });

  it('same company with a different JD is a full cache miss', async () => {
    const script = scriptGemini(true);
    const researchCompany = vi.fn(async () => fakeResearchResult());
    const cache = fakeCache();
    const build = () =>
      new KitGenerationService({
        research: { researchCompany },
        llm: { provider: 'gemini', generateJson: script.generateJson } as never,
        cache: cache as never,
        logger: silentLogger(),
      });

    await build().generate(generationInput(3));

    researchCompany.mockClear();
    script.generateJson.mockClear();

    await build().generate({
      ...generationInput(3),
      jd: 'A completely different role: designer who paints murals.',
    });

    expect(researchCompany).toHaveBeenCalled();
    expect(script.generateJson).toHaveBeenCalled();
  });

  it('invalid cached content is treated as a miss and replaced', async () => {
    const script = scriptGemini(true);
    const cache = fakeCache();
    const generation = new KitGenerationService({
      research: { researchCompany: vi.fn(async () => fakeResearchResult()) },
      llm: { provider: 'gemini', generateJson: script.generateJson } as never,
      cache: cache as never,
      logger: silentLogger(),
    });

    await generation.generate(generationInput(3));

    const firstCall = cache.upsert.mock.calls[0] as { fingerprint: string }[] | undefined;
    const fingerprint = (firstCall as { fingerprint: string }[])[0]?.fingerprint as string;
    (cache.findFresh as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fingerprint,
      content: { companyBrief: null },
    });
    script.generateJson.mockClear();

    const { kit } = await generation.generate(generationInput(3));

    expect(script.generateJson).toHaveBeenCalled();
    expect(kit.questions.length).toBeGreaterThan(0);
  });
});
