import type { Queue } from 'bullmq';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@/common/errors/http-exception';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { PaginatedResult, PaginationQuery } from '@/common/types/pagination.type';
import { calculateCoverage } from '@/modules/coverage/coverage.service';
import {
  enqueueKitGeneration,
  requeueKitGeneration,
} from '@/modules/generation/kit-generation.queue';
import type { GenerationJobData } from '@/modules/generation/generation.type';
import type { KitGenerationService } from '@/modules/generation/kit-generation.service';
import { buildResearchContext } from '@/modules/generation/research-context';
import type { CompanyResearchService } from '@/modules/research/company-research.service';
import {
  allocateFlashcardIds,
  allocateQuestionIds,
  sequencesFromContent,
} from '@/modules/kit/kit-id.service';
import type { FlashcardDraft, QuestionDraft } from '@/modules/kit/kit-id.type';
import type {
  AddFlashcardInput,
  AddQuestionInput,
  CreateKitInput,
  CreateKitResult,
  GenerationStep,
  KitDetailResult,
  KitStatusResult,
  KitSummary,
  RegenerateSectionInput,
  ReorderQuestionsInput,
  UpdateBriefInput,
  UpdateFlashcardInput,
  UpdateQuestionInput,
} from '@/modules/kit/kit-api.type';
import type { EditorMeta, KitDocument } from '@/modules/kit/kit.model';
import type { IdempotencyRepository } from '@/modules/kit/idempotency.repository';
import type { KitRepository } from '@/modules/kit/kit.repository';
import type { InterviewKit, KitFlashcard, KitQuestion } from '@/modules/kit/kit.type';
import type { Provider } from '@/common/providers/provider';
import { prepareSchedule } from '@/modules/schedule/schedule.service';

export type KitServiceDependencies = {
  kitRepository: KitRepository;
  idempotency: IdempotencyRepository;
  generationQueue: Queue<GenerationJobData>;
  // Lazy provider: resolving the generation service builds the LLM adapter,
  // which throws when unconfigured. createKit must work without keys (the
  // worker reports the config error on the job instead).
  kitGeneration: Provider<
    Pick<
      KitGenerationService,
      'generateBrief' | 'generateCategoryQuestions' | 'repairQuestions' | 'validateEditedKit'
    >
  >;
  research: Pick<CompanyResearchService, 'researchCompany'>;
  logger: LoggerService;
};

const STATUS_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'queued', label: 'Queued' },
  { key: 'researching', label: 'Researching company' },
  { key: 'analyzing-jd', label: 'Analyzing job description' },
  { key: 'generating', label: 'Generating interview kit' },
  { key: 'checking-coverage', label: 'Checking coverage' },
  { key: 'building-schedule', label: 'Building schedule' },
];

// Stale-write message surfaced by the frontend with a refetch.
export const KIT_CONFLICT_MESSAGE = 'Kit changed; refreshing latest version.';

const questionMetaOf = (
  meta: EditorMeta,
  id: string,
): NonNullable<EditorMeta['questions']>[string] => meta.questions?.[id] ?? {};

const markQuestion = (
  meta: EditorMeta,
  id: string,
  flags: { pinned?: boolean; edited?: boolean; manual?: boolean },
): EditorMeta => ({
  ...meta,
  questions: { ...(meta.questions ?? {}), [id]: { ...questionMetaOf(meta, id), ...flags } },
});

const isPreserved = (meta: EditorMeta, id: string): boolean => {
  const flags = questionMetaOf(meta, id);
  return flags.pinned === true || flags.edited === true || flags.manual === true;
};

// __v lives on the Kit document only — never inside the canonical
// InterviewKit JSON.
const docVersion = (doc: KitDocument): number | undefined => {
  const version = (doc as unknown as { __v?: unknown }).__v;
  return typeof version === 'number' ? version : undefined;
};

const idempotencyKeyPrefix = (key: string): string => key.slice(0, 8);

// Mongoose nested subdocuments do not spread to plain objects (counters live
// behind prototype getters), so `{ ...doc.idSequences }` yields undefined
// values and every ID allocation throws. Pick the counters explicitly; kits
// persisted without sequences fall back to the highest allocated IDs in the
// stored content so builder additions never collide.
const sequencesOf = (
  doc: Pick<KitDocument, 'idSequences' | 'kit'>,
): { requirement: number; question: number; flashcard: number } => {
  const stored = doc.idSequences as unknown as
    { requirement?: unknown; question?: unknown; flashcard?: unknown } | null | undefined;
  const pick = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const requirement = pick(stored?.requirement);
  const question = pick(stored?.question);
  const flashcard = pick(stored?.flashcard);

  if (requirement !== undefined && question !== undefined && flashcard !== undefined) {
    return { requirement, question, flashcard };
  }

  const content = doc.kit as InterviewKit;
  return sequencesFromContent(content.role.requirements, content.questions, content.flashcards);
};

export class KitService {
  constructor(private readonly dependencies: KitServiceDependencies) {}

  async listKits(
    userId: string,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<KitSummary>> {
    if (!Number.isSafeInteger(pagination.page) || !Number.isSafeInteger(pagination.limit)) {
      throw new BadRequestException('Page and limit must be safe integers.');
    }
    const result = await this.dependencies.kitRepository.findByUserPaginated(userId, pagination);
    return { items: result.items.map((kit) => this.toSummary(kit)), pagination: result.pagination };
  }

  // Persist the queued kit first (userId from the session, never the body),
  // then enqueue exactly one generation job keyed by kitId. Return now: the
  // worker thread does research + generation off the event loop.
  //
  // With an Idempotency-Key, the same logical submission retries to the
  // ORIGINAL kit: one Kit, one BullMQ job (jobId = kitId is the second
  // protection). A new intentional click must send a NEW key.
  async createKit(
    userId: string,
    input: CreateKitInput,
    idempotencyKey?: string,
  ): Promise<CreateKitResult> {
    const operation = 'create-kit';

    if (idempotencyKey) {
      const replay = await this.replayCreate(userId, operation, idempotencyKey);

      if (replay) {
        return replay;
      }
    }

    const kit = await this.dependencies.kitRepository.create({
      userId,
      jd: input.jd,
      companyUrl: input.companyUrl,
      days: input.days,
    });

    if (idempotencyKey) {
      await this.dependencies.idempotency.attachResource(userId, operation, idempotencyKey, kit.id);
    }

    try {
      await enqueueKitGeneration(this.dependencies.generationQueue, {
        kitId: kit.id,
        userId,
        jd: input.jd,
        companyUrl: input.companyUrl,
        days: input.days,
      });
    } catch (error) {
      await this.dependencies.kitRepository.updateGenerationState(userId, kit.id, {
        status: 'failed',
        stageMessage: 'Could not enqueue generation.',
        error: { code: 'ENQUEUE_FAILED', message: 'Could not start generation. Try again.' },
      });

      if (idempotencyKey) {
        await this.dependencies.idempotency.fail(userId, operation, idempotencyKey);
      }

      throw error;
    }

    if (idempotencyKey) {
      await this.dependencies.idempotency.complete(userId, operation, idempotencyKey);
    }

    this.dependencies.logger.info('kit.created', {
      userId,
      kitId: kit.id,
      ...(idempotencyKey ? { idempotencyKeyPrefix: idempotencyKeyPrefix(idempotencyKey) } : {}),
    });

    return { kitId: kit.id, status: kit.status };
  }

  // Returns the original result when this key already completed, the live
  // status when the first attempt is still processing, or null when the
  // caller owns the key and must execute. A lost race (claim failed) replays
  // the winner instead of creating a second kit.
  private async replayCreate(
    userId: string,
    operation: string,
    key: string,
  ): Promise<CreateKitResult | null> {
    const { idempotency, kitRepository } = this.dependencies;
    const existing = await idempotency.find(userId, operation, key);

    if (existing?.status === 'completed' && existing.resourceId) {
      const kit = await kitRepository.findOwnedById(userId, existing.resourceId);

      return { kitId: existing.resourceId, status: kit?.status ?? 'queued' };
    }

    if (existing?.status === 'processing' && existing.resourceId) {
      const kit = await kitRepository.findOwnedById(userId, existing.resourceId);

      if (kit) {
        return { kitId: kit.id, status: kit.status };
      }

      return null;
    }

    if (existing?.status === 'failed') {
      return null;
    }

    if (!existing) {
      const claim = await idempotency.claim(userId, operation, key);

      if (!claim.claimed) {
        return this.replayCreate(userId, operation, key);
      }

      return null;
    }

    // Processing without a resource yet: the first attempt is inside the
    // millisecond window between claim and kit creation. Poll briefly, then
    // report the conflict instead of creating a second kit.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(100);
      const retry = await idempotency.find(userId, operation, key);

      if (retry?.status === 'completed' && retry.resourceId) {
        const kit = await kitRepository.findOwnedById(userId, retry.resourceId);
        return { kitId: retry.resourceId, status: kit?.status ?? 'queued' };
      }

      if (retry?.status !== 'processing') {
        return this.replayCreate(userId, operation, key);
      }
    }

    throw new ConflictException('This create request is already being processed.');
  }

  // User-controlled retry of a FAILED kit: reuses the same kitId and the
  // already-persisted inputs (jd, companyUrl, days), clears the previous
  // failure, resets status to queued, and leaves exactly one active
  // generation job. Only failed kits retry; anything else is a 409. With an
  // Idempotency-Key, transport repeats replay instead of re-enqueueing.
  async retryGeneration(
    userId: string,
    kitId: string,
    idempotencyKey?: string,
  ): Promise<CreateKitResult> {
    const operation = `kit:${kitId}:retry-generation`;
    const kit = await this.requireOwnedKit(userId, kitId);

    if (idempotencyKey) {
      const replay = await this.replayRetry(userId, operation, idempotencyKey, kit.id, kit.status);

      if (replay) {
        return replay;
      }
    }

    if (kit.status !== 'failed') {
      // A claimed key that never executes must not block the key: release it
      // so the same key stays usable.
      if (idempotencyKey) {
        await this.dependencies.idempotency.fail(userId, operation, idempotencyKey);
      }

      throw new ConflictException('Only a failed kit can be retried.');
    }

    await this.dependencies.kitRepository.updateGenerationState(userId, kitId, {
      status: 'queued',
      stage: 'queued',
      stageMessage: 'Retry queued.',
      error: null,
    });

    try {
      await requeueKitGeneration(this.dependencies.generationQueue, {
        kitId: kit.id,
        userId,
        jd: kit.input.jd,
        companyUrl: kit.input.companyUrl,
        days: kit.input.days,
      });
    } catch (error) {
      await this.dependencies.kitRepository.updateGenerationState(userId, kitId, {
        status: 'failed',
        stageMessage: 'Could not enqueue generation.',
        error: { code: 'ENQUEUE_FAILED', message: 'Could not start generation. Try again.' },
      });

      if (idempotencyKey) {
        await this.dependencies.idempotency.fail(userId, operation, idempotencyKey);
      }

      throw error;
    }

    if (idempotencyKey) {
      await this.dependencies.idempotency.complete(userId, operation, idempotencyKey);
    }

    this.dependencies.logger.info('kit.retry_queued', {
      userId,
      kitId,
      retryAction: true,
      ...(idempotencyKey ? { idempotencyKeyPrefix: idempotencyKeyPrefix(idempotencyKey) } : {}),
    });

    return { kitId: kit.id, status: 'queued' };
  }

  // Same key repeated → the current kit status without a second BullMQ job.
  // The claim lands before any side effect, so a lost claim race replays the
  // winner; failed records re-run under the same key.
  private async replayRetry(
    userId: string,
    operation: string,
    key: string,
    kitId: string,
    status: CreateKitResult['status'],
  ): Promise<CreateKitResult | null> {
    const { idempotency } = this.dependencies;
    const existing = await idempotency.find(userId, operation, key);

    if (existing?.status === 'completed' || existing?.status === 'processing') {
      if (existing.resourceId && existing.resourceId !== kitId) {
        throw new ConflictException('This retry key was already used for another kit.');
      }

      // Only the claim winner below may execute; every other holder of the
      // key replays the live status without touching the queue.
      return { kitId, status };
    }

    if (existing?.status === 'failed') {
      return null;
    }

    if (!existing) {
      const claim = await idempotency.claim(userId, operation, key);

      if (!claim.claimed) {
        return this.replayRetry(userId, operation, key, kitId, status);
      }

      await idempotency.attachResource(userId, operation, key, kitId);
      return null;
    }

    return null;
  }

  async getKit(userId: string, kitId: string): Promise<KitDetailResult> {
    const kit = await this.requireOwnedKit(userId, kitId);
    return {
      id: kit.id,
      status: kit.status,
      kit: kit.kit,
      practiceRecords: kit.practiceRecords.map((record) => ({
        flashcardId: record.flashcardId,
        confidence: record.confidence,
        recordedAt: record.recordedAt.toISOString(),
      })),
    };
  }

  async getKitStatus(userId: string, kitId: string): Promise<KitStatusResult> {
    const kit = await this.requireOwnedKit(userId, kitId);
    return {
      kitId: kit.id,
      status: kit.status,
      progress: this.progressOf(kit.stage, kit.status),
      steps: this.stepsOf(kit.stage, kit.status, kit.stageMessage),
      ...(kit.error ? { error: { code: kit.error.code, message: kit.error.message } } : {}),
      updatedAt: kit.updatedAt.toISOString(),
    };
  }

  // SET semantics per flashcard: repeating the same confidence PATCH leaves
  // exactly ONE logical f1 practice state.
  async recordPractice(
    userId: string,
    kitId: string,
    flashcardId: string,
    confidence: number,
  ): Promise<{ recorded: true }> {
    const kit = await this.requireCompletedKit(userId, kitId);
    const content = kit.kit as InterviewKit;

    if (!content.flashcards.some((flashcard) => flashcard.id === flashcardId)) {
      throw new NotFoundException('Flashcard not found');
    }

    await this.dependencies.kitRepository.setPracticeConfidence(userId, kitId, {
      flashcardId,
      confidence,
    });

    return { recorded: true };
  }

  async updateQuestion(
    userId: string,
    kitId: string,
    questionId: string,
    input: UpdateQuestionInput,
  ): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta) => {
      const question = kit.questions.find((entry) => entry.id === questionId);

      if (!question) {
        throw new NotFoundException('Question not found');
      }

      if (input.prompt !== undefined) {
        question.prompt = input.prompt;
      }

      if (input.answer_outline !== undefined) {
        question.answer_outline = input.answer_outline;
      }

      if (input.category !== undefined) {
        question.category = input.category;
      }

      if (input.difficulty !== undefined) {
        question.difficulty = input.difficulty;
      }

      // Any touch pins the question; prompt/outline/category moves mark it
      // edited so category regeneration preserves it.
      return markQuestion(meta, questionId, { pinned: true, edited: true });
    });
  }

  async addQuestion(
    userId: string,
    kitId: string,
    input: AddQuestionInput,
    idempotencyKey?: string,
  ): Promise<InterviewKit> {
    return this.idempotentKitMutation(
      userId,
      kitId,
      `kit:${kitId}:add-question`,
      idempotencyKey,
      () =>
        this.mutateKit(userId, kitId, (kit, meta, sequences) => {
          const requirementIds = new Set(kit.role.requirements.map((entry) => entry.id));
          // Manual questions may legitimately reference nothing: thin kits have
          // zero requirements, and no fake mapping is invented here.
          const refs = [...new Set(input.requirement_ids ?? [])].filter((id) =>
            requirementIds.has(id),
          );

          const draft: QuestionDraft = {
            prompt: input.prompt,
            answer_outline: input.answer_outline,
            category: input.category,
            difficulty: input.difficulty ?? 2,
            requirement_ids: refs,
          };
          const [first] = allocateQuestionIds([draft], sequences);
          const created = first as KitQuestion;
          kit.questions.push(created);

          // Keep the final-kit invariant (every question scheduled exactly once):
          // manual questions join the last day.
          const lastDay = kit.schedule.days[kit.schedule.days.length - 1];

          if (lastDay) {
            lastDay.question_ids.push(created.id);
            lastDay.minutes = lastDay.question_ids.length * 30;
          }

          kit.coverage = {
            uncovered_requirement_ids: calculateCoverage(kit.role.requirements, kit.questions)
              .uncovered_requirement_ids,
            passes: kit.coverage.passes,
          };

          return markQuestion(meta, created.id, { pinned: true, manual: true });
        }),
    );
  }

  async reorderQuestions(
    userId: string,
    kitId: string,
    input: ReorderQuestionsInput,
  ): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta) => {
      const current = new Set(kit.questions.map((question) => question.id));
      const next = new Set(input.questionIds);

      if (next.size !== input.questionIds.length || next.size !== current.size) {
        throw new BadRequestException('Reorder must list every question exactly once.');
      }

      for (const id of input.questionIds) {
        if (!current.has(id)) {
          throw new BadRequestException('Reorder must list every question exactly once.');
        }
      }

      const byId = new Map(kit.questions.map((question) => [question.id, question]));
      kit.questions = input.questionIds.map((id) => byId.get(id) as KitQuestion);

      return meta;
    });
  }

  // Retry-friendly: deleting an already-deleted question returns the current
  // kit instead of failing. Honest thin kits may reach zero questions; an
  // uncovered must is then shown truthfully, never auto-filled.
  async deleteQuestion(userId: string, kitId: string, questionId: string): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta) => {
      if (!kit.questions.some((question) => question.id === questionId)) {
        return meta;
      }

      kit.questions = kit.questions.filter((question) => question.id !== questionId);

      for (const day of kit.schedule.days) {
        day.question_ids = day.question_ids.filter((id) => id !== questionId);
        day.minutes = day.question_ids.length * 30;
      }

      kit.coverage = {
        uncovered_requirement_ids: calculateCoverage(kit.role.requirements, kit.questions)
          .uncovered_requirement_ids,
        passes: kit.coverage.passes,
      };

      const remaining = { ...(meta.questions ?? {}) };
      delete remaining[questionId];
      return { ...meta, questions: remaining };
    });
  }

  async addFlashcard(
    userId: string,
    kitId: string,
    input: AddFlashcardInput,
    idempotencyKey?: string,
  ): Promise<InterviewKit> {
    return this.idempotentKitMutation(
      userId,
      kitId,
      `kit:${kitId}:add-flashcard`,
      idempotencyKey,
      () =>
        this.mutateKit(userId, kitId, (kit, meta, sequences) => {
          const requirementIds = new Set(kit.role.requirements.map((entry) => entry.id));
          const draft: FlashcardDraft = {
            front: input.front,
            back: input.back,
            requirement_ids: [...new Set(input.requirement_ids ?? [])].filter((id) =>
              requirementIds.has(id),
            ),
          };
          const [first] = allocateFlashcardIds([draft], sequences);
          const created = first as KitFlashcard;
          kit.flashcards.push(created);

          return markQuestion(meta, created.id, { pinned: true, manual: true });
        }),
    );
  }

  async updateFlashcard(
    userId: string,
    kitId: string,
    flashcardId: string,
    input: UpdateFlashcardInput,
  ): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta) => {
      const flashcard = kit.flashcards.find((entry) => entry.id === flashcardId);

      if (!flashcard) {
        throw new NotFoundException('Flashcard not found');
      }

      if (input.front !== undefined) {
        flashcard.front = input.front;
      }

      if (input.back !== undefined) {
        flashcard.back = input.back;
      }

      return markQuestion(meta, flashcardId, { pinned: true, edited: true });
    });
  }

  async deleteFlashcard(userId: string, kitId: string, flashcardId: string): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta) => {
      if (!kit.flashcards.some((flashcard) => flashcard.id === flashcardId)) {
        return meta;
      }

      kit.flashcards = kit.flashcards.filter((flashcard) => flashcard.id !== flashcardId);

      const remaining = { ...(meta.questions ?? {}) };
      delete remaining[flashcardId];
      return { ...meta, questions: remaining };
    });
  }

  async updateBrief(userId: string, kitId: string, input: UpdateBriefInput): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta) => {
      const edited = new Set(meta.briefFields ?? []);

      if (input.summary !== undefined) {
        kit.company_brief.summary = input.summary;
        edited.add('summary');
      }

      if (input.what_they_do !== undefined) {
        kit.company_brief.what_they_do = input.what_they_do;
        edited.add('what_they_do');
      }

      return { ...meta, briefFields: [...edited] };
    });
  }

  // Regeneration triggers LLM calls and is idempotent per action key: the
  // same key repeated returns the current kit without a second LLM call; a
  // new click sends a new key. A regeneration that cannot cover a must
  // requirement fails WITHOUT saving, preserving the persisted kit.
  async regenerate(
    userId: string,
    kitId: string,
    input: RegenerateSectionInput,
    idempotencyKey?: string,
  ): Promise<InterviewKit> {
    const operation =
      input.section === 'questions'
        ? `kit:${kitId}:regenerate:questions:${input.category}`
        : `kit:${kitId}:regenerate:${input.section}`;

    return this.idempotentKitMutation(userId, kitId, operation, idempotencyKey, async () => {
      const doc = await this.requireCompletedKit(userId, kitId);
      const content = structuredClone(doc.kit as InterviewKit);
      const meta: EditorMeta = structuredClone(doc.editorMeta ?? {});
      const sequences = sequencesOf(doc);

      if (input.section === 'schedule') {
        // No LLM: deterministic schedule over the current questions.
        content.schedule = {
          days_available: doc.input.days,
          days: prepareSchedule({
            requirements: content.role.requirements,
            questions: content.questions,
            daysAvailable: doc.input.days,
          }).schedule.days,
        };
      } else {
        const context = await this.freshResearchContext(doc, content);

        if (input.section === 'company_brief') {
          const brief = await this.dependencies
            .kitGeneration()
            .generateBrief(content.role.title, content.role.requirements, context);
          const edited = new Set(meta.briefFields ?? []);

          // Edited brief fields survive regeneration; only the rest refresh.
          content.company_brief = {
            summary: edited.has('summary') ? content.company_brief.summary : brief.summary,
            what_they_do: edited.has('what_they_do')
              ? content.company_brief.what_they_do
              : brief.what_they_do,
            sources: context.pagesUsed,
          };
        } else {
          const fresh = await this.dependencies
            .kitGeneration()
            .generateCategoryQuestions(
              input.category,
              content.role.title,
              content.role.requirements,
              context,
            );
          const preserved = content.questions.filter(
            (question) => question.category !== input.category || isPreserved(meta, question.id),
          );
          const preservedIds = new Set(preserved.map((question) => question.id));
          const created = allocateQuestionIds(
            fresh.map((draft) => ({ ...draft, category: input.category })),
            sequences,
          );

          for (const question of created) {
            if (preservedIds.has(question.id)) {
              throw new BadRequestException('Regeneration produced a duplicate question ID.');
            }
          }

          content.questions = [...preserved, ...created];

          // Exactly ONE targeted repair when a must requirement lost coverage;
          // then coverage again. A still-uncovered must fails the regen WITHOUT
          // saving, so the persisted kit is never left half-broken.
          let coverage = calculateCoverage(content.role.requirements, content.questions);

          if (coverage.uncovered_requirement_ids.length > 0) {
            const repaired = await this.dependencies
              .kitGeneration()
              .repairQuestions(content.role.requirements, content.questions, context);
            const repairedAllocated = allocateQuestionIds(repaired, sequences);

            for (const question of repairedAllocated) {
              if (preservedIds.has(question.id)) {
                throw new BadRequestException('Regeneration produced a duplicate question ID.');
              }
            }

            content.questions = [...content.questions, ...repairedAllocated];
            coverage = calculateCoverage(content.role.requirements, content.questions);
          }

          if (coverage.uncovered_requirement_ids.length > 0) {
            throw new ConflictException(
              'Regeneration could not cover every must-have requirement; kit unchanged.',
            );
          }

          // The question set changed: rebuild the deterministic schedule from
          // ALL final questions instead of patching old day allocations.
          content.schedule = {
            days_available: doc.input.days,
            days: prepareSchedule({
              requirements: content.role.requirements,
              questions: content.questions,
              daysAvailable: doc.input.days,
            }).schedule.days,
          };

          content.coverage = {
            uncovered_requirement_ids: coverage.uncovered_requirement_ids,
            passes: content.coverage.passes,
          };
        }
      }

      const validated = this.dependencies.kitGeneration().validateEditedKit(content);
      const saved = await this.dependencies.kitRepository.saveEditedKit(
        userId,
        kitId,
        validated,
        sequences,
        meta,
        docVersion(doc),
      );

      if (!saved) {
        throw await this.conflictOrNotFound(userId, kitId);
      }

      return validated;
    });
  }

  // Same key repeated → the previously completed result (current kit), no
  // second side effect. A lost claim race replays the winner. Failed records
  // re-claim so the same key can retry after a failure.
  private async idempotentKitMutation(
    userId: string,
    kitId: string,
    operation: string,
    key: string | undefined,
    mutate: () => Promise<InterviewKit>,
  ): Promise<InterviewKit> {
    if (!key) {
      return mutate();
    }

    const { idempotency } = this.dependencies;
    const existing = await idempotency.find(userId, operation, key);

    if (existing?.status === 'completed') {
      return this.currentKitContent(userId, kitId);
    }

    if (existing?.status === 'processing') {
      return this.currentKitContent(userId, kitId);
    }

    // A failed record re-runs under the same key; complete()/fail() below
    // transition it out of the failed state.
    if (!existing) {
      const claim = await idempotency.claim(userId, operation, key);

      if (!claim.claimed) {
        return this.currentKitContent(userId, kitId);
      }
    }

    try {
      const result = await mutate();
      await idempotency.complete(userId, operation, key);
      return result;
    } catch (error) {
      await idempotency.fail(userId, operation, key);
      throw error;
    }
  }

  private async currentKitContent(userId: string, kitId: string): Promise<InterviewKit> {
    const kit = await this.requireCompletedKit(userId, kitId);
    return structuredClone(kit.kit as InterviewKit);
  }

  private async freshResearchContext(
    doc: KitDocument,
    content: InterviewKit,
  ): Promise<ReturnType<typeof buildResearchContext>> {
    const research = await this.dependencies.research.researchCompany({
      companyUrl: doc.input.companyUrl,
      roleHint: content.role.title,
      mode: 'production',
    });

    return buildResearchContext(research);
  }

  private async mutateKit(
    userId: string,
    kitId: string,
    apply: (
      kit: InterviewKit,
      meta: EditorMeta,
      sequences: { requirement: number; question: number; flashcard: number },
    ) => EditorMeta,
  ): Promise<InterviewKit> {
    const doc = await this.requireCompletedKit(userId, kitId);
    const content = structuredClone(doc.kit as InterviewKit);
    const meta: EditorMeta = structuredClone(doc.editorMeta ?? {});
    const sequences = sequencesOf(doc);

    const nextMeta = apply(content, meta, sequences);
    const validated = this.dependencies.kitGeneration().validateEditedKit(content);
    const saved = await this.dependencies.kitRepository.saveEditedKit(
      userId,
      kitId,
      validated,
      sequences,
      nextMeta,
      docVersion(doc),
    );

    if (!saved) {
      throw await this.conflictOrNotFound(userId, kitId);
    }

    return validated;
  }

  // A save that matches nothing means the version moved (concurrent edit →
  // 409 with a refetch hint) or the kit vanished (404). Never silent.
  private async conflictOrNotFound(
    userId: string,
    kitId: string,
  ): Promise<ConflictException | NotFoundException> {
    const stillThere = await this.dependencies.kitRepository.findOwnedById(userId, kitId);

    if (stillThere) {
      return new ConflictException(KIT_CONFLICT_MESSAGE);
    }

    return new NotFoundException('Kit not found');
  }

  private async requireOwnedKit(userId: string, kitId: string): Promise<KitDocument> {
    const kit = await this.dependencies.kitRepository.findOwnedById(userId, kitId);

    if (!kit) {
      throw new NotFoundException('Kit not found');
    }

    return kit;
  }

  private async requireCompletedKit(userId: string, kitId: string): Promise<KitDocument> {
    const kit = await this.requireOwnedKit(userId, kitId);

    if (kit.status !== 'completed' || !kit.kit) {
      throw new ConflictException('This kit is not ready yet.');
    }

    return kit;
  }

  private progressOf(stage: string | undefined, status: string): number {
    if (status === 'completed') {
      return 100;
    }

    const index = STATUS_STEPS.findIndex((step) => step.key === stage);
    return index <= 0 ? 0 : Math.round((index / STATUS_STEPS.length) * 100);
  }

  private stepsOf(
    stage: string | undefined,
    status: string,
    message: string | undefined,
  ): GenerationStep[] {
    const current = STATUS_STEPS.findIndex((step) => step.key === stage);

    return STATUS_STEPS.map((step, index) => {
      if (status === 'completed') {
        return { ...step, state: 'completed' as const };
      }

      if (status === 'failed' && index === current) {
        return { ...step, state: 'failed' as const, ...(message ? { message } : {}) };
      }

      if (index < current || (status === 'failed' && current < 0)) {
        return { ...step, state: 'completed' as const };
      }

      if (index === current && status === 'running') {
        return { ...step, state: 'running' as const, ...(message ? { message } : {}) };
      }

      return { ...step, state: 'pending' as const };
    });
  }

  private toSummary(kit: KitDocument): KitSummary {
    let company = '';
    try {
      company = new URL(kit.input.companyUrl).hostname;
    } catch {
      company = '';
    }

    return {
      id: kit.id,
      company,
      role: kit.kit?.role.title ?? '',
      status: kit.status,
      createdAt: kit.createdAt.toISOString(),
      updatedAt: kit.updatedAt.toISOString(),
    };
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
