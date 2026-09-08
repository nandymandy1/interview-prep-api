import { BadRequestException } from '@/common/errors/http-exception';
import { KitValidationException } from '@/common/errors/kit-validation.exception';
import { calculateCoverage } from '@/modules/coverage/coverage.service';
import {
  allocateFlashcardIds,
  allocateQuestionIds,
  allocateRequirementIds,
  allocateStableId,
  createInitialSequences,
} from '@/modules/kit/kit-id.service';
import type { KitIdSequences } from '@/modules/kit/kit-id.type';
import type { InterviewKit, KitQuestion, KitRequirement } from '@/modules/kit/kit.type';
import { validateFinalInterviewKit, validateInterviewKit } from '@/modules/kit/kit.validator';
import { allocateSchedule, prepareSchedule } from '@/modules/schedule/schedule.service';
import { describe, expect, it } from 'vitest';

const requirements: KitRequirement[] = [
  { id: 'r1', text: 'TypeScript', kind: 'technical', priority: 'must' },
  { id: 'r2', text: 'System design', kind: 'technical', priority: 'must' },
  { id: 'r3', text: 'Fintech', kind: 'domain', priority: 'nice' },
];

const questions: KitQuestion[] = [
  {
    id: 'q1',
    requirement_ids: ['r1'],
    category: 'technical',
    prompt: 'TypeScript?',
    answer_outline: 'Types',
    difficulty: 3,
  },
  {
    id: 'q2',
    requirement_ids: ['r2', 'r3'],
    category: 'system-design',
    prompt: 'Design?',
    answer_outline: 'Tradeoffs',
    difficulty: 2,
  },
  {
    id: 'q3',
    requirement_ids: ['r3'],
    category: 'company-fit',
    prompt: 'Why us?',
    answer_outline: 'Research',
    difficulty: 1,
  },
];

const createKit = (): InterviewKit => ({
  source: {
    company: 'Acme',
    company_url: 'https://acme.test',
    role: 'Engineer',
    location: 'Remote',
    jd_chars: 100,
    researched_at: '2026-09-08T00:00:00.000Z',
    pages_used: ['https://acme.test/jobs'],
  },
  company_brief: {
    summary: 'Summary',
    what_they_do: 'Builds software',
    sources: ['https://acme.test'],
  },
  role: { title: 'Engineer', seniority: 'Senior', responsibilities: ['Build'], requirements },
  questions,
  flashcards: [{ id: 'f1', front: 'Type?', back: 'Static', requirement_ids: ['r1'] }],
  schedule: {
    days_available: 2,
    days: [
      { day: 1, focus: 'Practice', question_ids: ['q1'], minutes: 30 },
      { day: 2, focus: 'Practice', question_ids: ['q2', 'q3'], minutes: 60 },
    ],
  },
  coverage: { uncovered_requirement_ids: [], passes: 1 },
});

describe('stable kit IDs', () => {
  it('fresh question allocation: sequence 0 → q1', () => {
    const sequences: KitIdSequences = createInitialSequences();
    expect(allocateStableId(sequences, 'q')).toBe('q1');
    expect(sequences.question).toBe(1);
  });

  it('sequential allocation: q1 → q2 → q3', () => {
    const sequences = createInitialSequences();
    expect(
      allocateQuestionIds(
        [
          {
            requirement_ids: [],
            category: 'technical',
            prompt: 'A',
            answer_outline: 'B',
            difficulty: 1,
          },
          {
            requirement_ids: [],
            category: 'technical',
            prompt: 'B',
            answer_outline: 'B',
            difficulty: 1,
          },
          {
            requirement_ids: [],
            category: 'technical',
            prompt: 'C',
            answer_outline: 'B',
            difficulty: 1,
          },
        ],
        sequences,
      ).map((q) => q.id),
    ).toEqual(['q1', 'q2', 'q3']);
    expect(sequences.question).toBe(3);
  });

  it('deletion does not permit reuse: high-water 3 surviving q1,q2 next must be q4', () => {
    const sequences: KitIdSequences = { requirement: 3, question: 3, flashcard: 2 };
    // surviving IDs are q1,q2 (q3 deleted), but high-water is 3
    expect(allocateStableId(sequences, 'q')).toBe('q4');
    expect(sequences.question).toBe(4);
  });

  it('subsequent allocation after deleted reuse guard: next is q5', () => {
    const sequences: KitIdSequences = { requirement: 0, question: 3, flashcard: 0 };
    expect(allocateStableId(sequences, 'q')).toBe('q4');
    expect(allocateStableId(sequences, 'q')).toBe('q5');
    expect(sequences.question).toBe(5);
  });

  it('retained lifecycle: allocate A/B/C, delete q3, same sequences yield q4 then q5', () => {
    const sequences = createInitialSequences();
    const drafts = (prompt: string) => ({
      requirement_ids: [],
      category: 'technical' as const,
      prompt,
      answer_outline: 'B',
      difficulty: 1 as const,
    });
    expect(
      allocateQuestionIds([drafts('A'), drafts('B'), drafts('C')], sequences).map((q) => q.id),
    ).toEqual(['q1', 'q2', 'q3']);
    expect(sequences.question).toBe(3);
    // q3 deleted; surviving q1/q2 must not cause reuse because sequences are retained.
    expect(allocateQuestionIds([drafts('D')], sequences).map((q) => q.id)).toEqual(['q4']);
    expect(allocateQuestionIds([drafts('E')], sequences).map((q) => q.id)).toEqual(['q5']);
    expect(sequences.question).toBe(5);
  });

  it('retained lifecycle covers requirement and flashcard counters', () => {
    const sequences = createInitialSequences();
    const requirement = (text: string) => ({
      text,
      kind: 'technical' as const,
      priority: 'must' as const,
    });
    const flashcard = (front: string) => ({ front, back: 'B', requirement_ids: [] as string[] });
    expect(
      allocateRequirementIds([requirement('A'), requirement('B')], sequences).map((r) => r.id),
    ).toEqual(['r1', 'r2']);
    expect(
      allocateFlashcardIds([flashcard('A'), flashcard('B')], sequences).map((f) => f.id),
    ).toEqual(['f1', 'f2']);
    // r2 and f2 deleted; retained high-water forces r3/f3 next.
    expect(allocateRequirementIds([requirement('C')], sequences).map((r) => r.id)).toEqual(['r3']);
    expect(allocateFlashcardIds([flashcard('C')], sequences).map((f) => f.id)).toEqual(['f3']);
    expect(sequences).toEqual({ requirement: 3, question: 0, flashcard: 3 });
  });

  it('keeps separate high-water per prefix', () => {
    const sequences: KitIdSequences = { requirement: 1, question: 2, flashcard: 5 };
    expect(allocateStableId(sequences, 'q')).toBe('q3');
    expect(allocateStableId(sequences, 'f')).toBe('f6');
    expect(allocateStableId(sequences, 'r')).toBe('r2');
  });

  it('accepts zero and normal positive safe-integer counters', () => {
    const sequences: KitIdSequences = { requirement: 0, question: 41, flashcard: 0 };
    expect(allocateStableId(sequences, 'q')).toBe('q42');
    expect(allocateStableId(sequences, 'r')).toBe('r1');
  });

  it.each([
    ['NaN', { requirement: Number.NaN, question: 0, flashcard: 0 }],
    ['Infinity', { requirement: 0, question: Number.POSITIVE_INFINITY, flashcard: 0 }],
    ['negative', { requirement: 0, question: 0, flashcard: -1 }],
    ['fractional', { requirement: 1.5, question: 0, flashcard: 0 }],
    ['unsafe integer', { requirement: 0, question: Number.MAX_SAFE_INTEGER + 1, flashcard: 0 }],
  ])('rejects %s sequence counters', (_name, sequences) => {
    expect(() => allocateStableId(sequences as KitIdSequences, 'q')).toThrow(
      KitValidationException,
    );
  });

  it('cannot increment Number.MAX_SAFE_INTEGER', () => {
    const sequences: KitIdSequences = {
      requirement: 0,
      question: Number.MAX_SAFE_INTEGER,
      flashcard: 0,
    };
    expect(() => allocateStableId(sequences, 'q')).toThrow(
      'Kit ID sequence has reached its maximum safe value.',
    );
    expect(sequences.question).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('deterministic input/state produces deterministic IDs across repeated allocate calls', () => {
    const make = (): string[] => {
      const seq = createInitialSequences();
      return allocateQuestionIds(
        [
          {
            requirement_ids: [],
            category: 'technical',
            prompt: 'A',
            answer_outline: 'B',
            difficulty: 1,
          },
          {
            requirement_ids: [],
            category: 'behavioural',
            prompt: 'B',
            answer_outline: 'B',
            difficulty: 2,
          },
        ],
        seq,
      ).map((q) => q.id);
    };
    expect(make()).toEqual(['q1', 'q2']);
    expect(make()).toEqual(['q1', 'q2']);
  });

  it('allocate* batch is source-order deterministic and consumes sequences monotonically', () => {
    const seq1 = createInitialSequences();
    const first = allocateRequirementIds(
      [
        { text: 'A', kind: 'technical', priority: 'must' },
        { text: 'B', kind: 'technical', priority: 'must' },
      ],
      seq1,
    );
    expect(first.map((r) => r.id)).toEqual(['r1', 'r2']);
    const second = allocateRequirementIds(
      [{ text: 'C', kind: 'technical', priority: 'must' }],
      seq1,
    );
    expect(second.map((r) => r.id)).toEqual(['r3']);
  });
});

describe('coverage', () => {
  it('finds uncovered must requirements while ignoring nice requirements and duplicate references', () => {
    expect(
      calculateCoverage(requirements, [{ ...questions[0]!, requirement_ids: ['r1', 'r1'] }]),
    ).toEqual({ uncovered_requirement_ids: ['r2'] });
  });

  it('returns no uncovered IDs when every must requirement is covered, including multi-requirement questions', () => {
    expect(calculateCoverage(requirements, questions)).toEqual({ uncovered_requirement_ids: [] });
  });
});

describe('schedule allocation', () => {
  for (const daysAvailable of [1, 2, 5, 60]) {
    it(`creates exactly ${daysAvailable} deterministic day(s) with valid integer allocations`, () => {
      const schedule = allocateSchedule({ requirements, questions, daysAvailable });
      expect(schedule).toEqual(allocateSchedule({ requirements, questions, daysAvailable }));
      expect(schedule.days).toHaveLength(daysAvailable);
      expect(schedule.days.every((day) => Number.isInteger(day.minutes))).toBe(true);
      expect(
        schedule.days
          .flatMap((day) => day.question_ids)
          .every((id) => questions.some((question) => question.id === id)),
      ).toBe(true);
      expect(schedule.days[0]?.question_ids).toContain('q1');
      expect(new Set(schedule.days.flatMap((day) => day.question_ids))).toEqual(
        new Set(['q1', 'q2', 'q3']),
      );
    });
  }

  it('rejects a must requirement without a covering question', () => {
    expect(() =>
      allocateSchedule({
        requirements,
        questions: questions.filter((question) => question.id !== 'q2'),
        daysAvailable: 1,
      }),
    ).toThrow(KitValidationException);
  });

  it('rejects duplicate nested requirement refs before schedule scoring', () => {
    const inflated = { ...questions[0]!, requirement_ids: ['r1', 'r1', 'r1'] };
    const input = {
      requirements,
      questions: [inflated, questions[1]!, questions[2]!],
      daysAvailable: 1,
    };
    expect(() => allocateSchedule(input)).toThrow(KitValidationException);
    expect(() => allocateSchedule(input)).toThrow('Duplicate');
    expect(() => prepareSchedule(input)).toThrow(KitValidationException);
  });

  it('rejects unknown requirement references before scheduler consumption', () => {
    const dangling = { ...questions[0]!, requirement_ids: ['missing'] };
    const input = {
      requirements,
      questions: [dangling, questions[1]!, questions[2]!],
      daysAvailable: 1,
    };
    expect(() => allocateSchedule(input)).toThrow(KitValidationException);
    expect(() => prepareSchedule(input)).toThrow(KitValidationException);
  });

  it('rejects duplicate requirement and question IDs before scheduling', () => {
    expect(() =>
      allocateSchedule({
        requirements: [...requirements, { ...requirements[0]! }],
        questions,
        daysAvailable: 1,
      }),
    ).toThrow('Duplicate requirement IDs');
    expect(() =>
      allocateSchedule({
        requirements,
        questions: [...questions, { ...questions[0]! }],
        daysAvailable: 1,
      }),
    ).toThrow('Duplicate question IDs');
  });

  it('prepareSchedule validates material, then computes coverage, then schedules', () => {
    const prepared = prepareSchedule({ requirements, questions, daysAvailable: 2 });
    expect(prepared.coverage).toEqual({ uncovered_requirement_ids: [] });
    expect(prepared.schedule).toEqual(
      allocateSchedule({ requirements, questions, daysAvailable: 2 }),
    );
    expect(prepared.schedule.days).toHaveLength(2);
  });

  it('rejects whitespace-equivalent requirement IDs as duplicates', () => {
    const input = {
      requirements: [...requirements, { ...requirements[0]!, id: ' r1 ' }],
      questions,
      daysAvailable: 1,
    };
    expect(() => allocateSchedule(input)).toThrow('Duplicate requirement IDs');
    expect(() => prepareSchedule(input)).toThrow(KitValidationException);
  });

  it('rejects whitespace-equivalent question IDs as duplicates', () => {
    const input = {
      requirements,
      questions: [...questions, { ...questions[0]!, id: ' q1 ' }],
      daysAvailable: 1,
    };
    expect(() => allocateSchedule(input)).toThrow('Duplicate question IDs');
    expect(() => prepareSchedule(input)).toThrow(KitValidationException);
  });

  it('normalizes a padded requirement ref when the canonical ID exists', () => {
    const padded = { ...questions[0]!, id: ' q1 ', requirement_ids: [' r1 '] };
    const schedule = allocateSchedule({
      requirements,
      questions: [padded, questions[1]!, questions[2]!],
      daysAvailable: 1,
    });
    const scheduled = schedule.days.flatMap((day) => day.question_ids);
    expect(scheduled).toContain('q1');
    expect(scheduled).not.toContain(' q1 ');
  });

  it('rejects duplicate normalized nested refs', () => {
    const input = {
      requirements,
      questions: [
        { ...questions[0]!, requirement_ids: ['r1', ' r1 '] },
        questions[1]!,
        questions[2]!,
      ],
      daysAvailable: 1,
    };
    expect(() => allocateSchedule(input)).toThrow('Duplicate');
    expect(() => prepareSchedule(input)).toThrow(KitValidationException);
  });

  it.each([
    ['invalid category', { ...questions[0]!, category: 'bogus' } as unknown as KitQuestion],
    ['invalid difficulty', { ...questions[0]!, difficulty: 9 } as unknown as KitQuestion],
  ])('rejects %s before scoring', (_name, question) => {
    const input = {
      requirements,
      questions: [question, questions[1]!, questions[2]!],
      daysAvailable: 1,
    };
    expect(() => allocateSchedule(input)).toThrow(KitValidationException);
    expect(() => prepareSchedule(input)).toThrow(KitValidationException);
  });

  it('rejects unknown normalized requirement references before scoring', () => {
    const input = {
      requirements,
      questions: [
        { ...questions[0]!, requirement_ids: [' missing '] },
        questions[1]!,
        questions[2]!,
      ],
      daysAvailable: 1,
    };
    expect(() => allocateSchedule(input)).toThrow(KitValidationException);
    expect(() => prepareSchedule(input)).toThrow(KitValidationException);
  });

  it('keeps lower-priority questions after higher-priority questions instead of wrapping them early', () => {
    const schedule = allocateSchedule({ requirements, questions, daysAvailable: 2 });
    expect(schedule.days[0]?.question_ids).toEqual(['q1', 'q2']);
    expect(schedule.days[1]?.question_ids).toEqual(['q3']);
  });

  it('labels day focus deterministically from scheduled categories', () => {
    const schedule = allocateSchedule({ requirements, questions, daysAvailable: 2 });
    expect(schedule.days[0]?.focus).toBe('System Design + Technical');
    expect(schedule.days[1]?.focus).toBe('Company Fit');
    expect(schedule).toEqual(allocateSchedule({ requirements, questions, daysAvailable: 2 }));
  });

  it('keeps open review for days without scheduled questions', () => {
    const schedule = allocateSchedule({ requirements, questions, daysAvailable: 5 });
    expect(schedule.days).toHaveLength(5);
    expect(
      schedule.days.filter((day) => day.question_ids.length === 0).map((day) => day.focus),
    ).toEqual(['Open review', 'Open review']);
    expect(schedule.days.every((day) => day.focus.trim().length > 0)).toBe(true);
  });
});

describe('InterviewKit validation', () => {
  it('accepts a valid Appendix A kit', () => {
    expect(validateInterviewKit(createKit())).toEqual(createKit());
  });

  it('requires a completed, fully covered result for final kits', () => {
    const draft = createKit();
    draft.coverage.passes = 0;
    expect(() => validateFinalInterviewKit(draft)).toThrow(KitValidationException);
    expect(validateFinalInterviewKit(createKit())).toEqual(createKit());
  });

  it('rejects a vacuous final kit with zero requirements', () => {
    const kit = createKit();
    kit.role.requirements = [];
    kit.questions = [];
    kit.flashcards = [];
    kit.schedule = {
      days_available: 1,
      days: [{ day: 1, focus: 'Practice', question_ids: [], minutes: 0 }],
    };
    kit.coverage = { uncovered_requirement_ids: [], passes: 1 };

    expect(validateInterviewKit(kit)).toEqual(kit);
    expect(() => validateFinalInterviewKit(kit)).toThrow(
      'Final interview kit must contain at least one requirement.',
    );
  });

  it('rejects a vacuous final kit with zero questions', () => {
    const kit = createKit();
    kit.role.requirements = [{ id: 'r1', text: 'TypeScript', kind: 'technical', priority: 'nice' }];
    kit.questions = [];
    kit.flashcards = [];
    kit.schedule = {
      days_available: 1,
      days: [{ day: 1, focus: 'Practice', question_ids: [], minutes: 0 }],
    };
    kit.coverage = { uncovered_requirement_ids: [], passes: 1 };

    expect(validateInterviewKit(kit)).toEqual(kit);
    expect(() => validateFinalInterviewKit(kit)).toThrow(
      'Final interview kit must contain at least one question.',
    );
  });

  it('rejects incomplete must-have coverage for final kits while base validation passes', () => {
    const kit = createKit();
    kit.role.requirements = [
      { id: 'r1', text: 'TypeScript', kind: 'technical', priority: 'must' },
      { id: 'r2', text: 'System design', kind: 'technical', priority: 'must' },
    ];
    kit.questions = [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'TypeScript?',
        answer_outline: 'Types',
        difficulty: 3,
      },
    ];
    kit.flashcards = [];
    kit.schedule = {
      days_available: 1,
      days: [{ day: 1, focus: 'Practice', question_ids: ['q1'], minutes: 30 }],
    };
    kit.coverage = { uncovered_requirement_ids: ['r2'], passes: 1 };

    expect(validateInterviewKit(kit)).toEqual(kit);
    try {
      validateFinalInterviewKit(kit);
      expect.unreachable('final validation must reject incomplete coverage');
    } catch (error) {
      expect(error).toBeInstanceOf(KitValidationException);
      expect((error as KitValidationException).code).toBe('KIT_VALIDATION_ERROR');
      expect((error as KitValidationException).message).toBe(
        'Final interview kit must have completed coverage with no uncovered requirements.',
      );
    }
  });

  it('rejects a structurally valid final kit when a must requirement is not scheduled', () => {
    const kit = createKit();
    kit.schedule.days[1]!.question_ids = ['q3'];
    expect(validateInterviewKit(kit)).toEqual(kit);
    expect(() => validateFinalInterviewKit(kit)).toThrow(KitValidationException);
    expect(() => validateFinalInterviewKit(kit)).toThrow('must-have requirement');
  });

  it('requires every final question exactly once across all days', () => {
    const missing = createKit();
    missing.schedule.days[1]!.question_ids = ['q2'];
    expect(() => validateFinalInterviewKit(missing)).toThrow(KitValidationException);
    expect(() => validateFinalInterviewKit(missing)).toThrow('exactly once');
    const duplicate = createKit();
    duplicate.schedule.days[1]!.question_ids = ['q2', 'q3', 'q1'];
    expect(() => validateFinalInterviewKit(duplicate)).toThrow(KitValidationException);
    expect(() => validateFinalInterviewKit(duplicate)).toThrow('exactly once');
  });

  it.each([
    [
      'lying empty coverage',
      (kit: InterviewKit) => {
        kit.questions = [questions[0]!];
        kit.coverage.uncovered_requirement_ids = [];
      },
    ],
    [
      'incorrect uncovered ID',
      (kit: InterviewKit) => {
        kit.coverage.uncovered_requirement_ids = ['r1'];
      },
    ],
    [
      'nice uncovered ID',
      (kit: InterviewKit) => {
        kit.coverage.uncovered_requirement_ids = ['r3'];
      },
    ],
    [
      'duplicate question requirement reference',
      (kit: InterviewKit) => {
        kit.questions[0]!.requirement_ids = ['r1', 'r1'];
      },
    ],
    [
      'duplicate flashcard requirement reference',
      (kit: InterviewKit) => {
        kit.flashcards[0]!.requirement_ids = ['r1', 'r1'];
      },
    ],
    [
      'duplicate scheduled question ID',
      (kit: InterviewKit) => {
        kit.schedule.days[0]!.question_ids = ['q1', 'q1'];
      },
    ],
    [
      'duplicate uncovered ID',
      (kit: InterviewKit) => {
        kit.coverage.uncovered_requirement_ids = ['r1', 'r1'];
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const kit = createKit();
    mutate(kit);
    expect(() => validateInterviewKit(kit)).toThrow(KitValidationException);
  });

  it.each([
    [
      'difficulty',
      (kit: InterviewKit) => {
        kit.questions[0]!.difficulty = 4 as 1;
      },
    ],
    [
      'floating minutes',
      (kit: InterviewKit) => {
        kit.schedule.days[0]!.minutes = 1.5;
      },
    ],
    [
      'unknown requirement',
      (kit: InterviewKit) => {
        kit.questions[0]!.requirement_ids = ['missing'];
      },
    ],
    [
      'unknown schedule question',
      (kit: InterviewKit) => {
        kit.schedule.days[0]!.question_ids = ['missing'];
      },
    ],
    [
      'duplicate requirement',
      (kit: InterviewKit) => {
        kit.role.requirements.push({ ...requirements[0]! });
      },
    ],
    [
      'duplicate question',
      (kit: InterviewKit) => {
        kit.questions.push({ ...questions[0]! });
      },
    ],
    [
      'duplicate flashcard',
      (kit: InterviewKit) => {
        kit.flashcards.push({ ...kit.flashcards[0]! });
      },
    ],
    [
      'mismatched days',
      (kit: InterviewKit) => {
        kit.schedule.days.pop();
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const kit = createKit();
    mutate(kit);
    expect(() => validateInterviewKit(kit)).toThrow(KitValidationException);
  });

  it.each([
    [
      'blank responsibility',
      (kit: InterviewKit) => {
        kit.role.responsibilities = ['   '];
      },
    ],
    [
      'blank brief source',
      (kit: InterviewKit) => {
        kit.company_brief.sources = [''];
      },
    ],
    [
      'blank page used',
      (kit: InterviewKit) => {
        kit.source.pages_used = ['  '];
      },
    ],
    [
      'blank requirement ref',
      (kit: InterviewKit) => {
        kit.questions[0]!.requirement_ids = [' '];
      },
    ],
    [
      'blank scheduled question',
      (kit: InterviewKit) => {
        kit.schedule.days[0]!.question_ids = [''];
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const kit = createKit();
    mutate(kit);
    expect(() => validateInterviewKit(kit)).toThrow(KitValidationException);
  });

  it('rejects editor/lifecycle metadata inside the canonical kit', () => {
    const withTopLevel = {
      ...createKit(),
      sequences: { requirement: 3, question: 3, flashcard: 1 },
    };
    expect(() => validateInterviewKit(withTopLevel)).toThrow(KitValidationException);
    const withPinned = createKit();
    (withPinned.questions[0] as unknown as Record<string, unknown>)['pinned'] = true;
    expect(() => validateInterviewKit(withPinned)).toThrow(KitValidationException);
    const withExtra = createKit();
    (withExtra.coverage as unknown as Record<string, unknown>)['passesDraft'] = 0;
    expect(() => validateInterviewKit(withExtra)).toThrow(KitValidationException);
  });

  it('exposes a domain error code instead of HTTP semantics', () => {
    const kit = createKit();
    kit.questions[0]!.requirement_ids = ['missing'];
    try {
      validateInterviewKit(kit);
      expect.unreachable('semantic validation must reject unknown references');
    } catch (error) {
      expect(error).toBeInstanceOf(KitValidationException);
      expect((error as KitValidationException).code).toBe('KIT_VALIDATION_ERROR');
      expect(error).not.toBeInstanceOf(BadRequestException);
    }
  });
});
