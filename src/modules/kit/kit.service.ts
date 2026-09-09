import type { Queue } from 'bullmq';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@/common/errors/http-exception';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { PaginatedResult, PaginationQuery } from '@/common/types/pagination.type';
import { calculateCoverage } from '@/modules/coverage/coverage.service';
import { enqueueKitGeneration } from '@/modules/generation/kit-generation.queue';
import type { GenerationJobData } from '@/modules/generation/generation.type';
import type { KitGenerationService } from '@/modules/generation/kit-generation.service';
import { buildResearchContext } from '@/modules/generation/research-context';
import type { CompanyResearchService } from '@/modules/research/company-research.service';
import { allocateFlashcardIds, allocateQuestionIds } from '@/modules/kit/kit-id.service';
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
import type { KitRepository } from '@/modules/kit/kit.repository';
import type { InterviewKit, KitFlashcard, KitQuestion } from '@/modules/kit/kit.type';
import { prepareSchedule } from '@/modules/schedule/schedule.service';

export type KitServiceDependencies = {
  kitRepository: KitRepository;
  generationQueue: Queue<GenerationJobData>;
  kitGeneration: Pick<
    KitGenerationService,
    'generateBrief' | 'generateCategoryQuestions' | 'validateEditedKit'
  >;
  research: Pick<CompanyResearchService, 'researchCompany'>;
  logger: LoggerService;
};

const STATUS_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'queued', label: 'Queued' },
  { key: 'researching', label: 'Researching company' },
  { key: 'generating', label: 'Generating interview kit' },
  { key: 'checking-coverage', label: 'Checking coverage' },
  { key: 'building-schedule', label: 'Building schedule' },
];

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
  async createKit(userId: string, input: CreateKitInput): Promise<CreateKitResult> {
    const kit = await this.dependencies.kitRepository.create({
      userId,
      jd: input.jd,
      companyUrl: input.companyUrl,
      days: input.days,
    });

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
      throw error;
    }

    this.dependencies.logger.info('kit.created', { userId, kitId: kit.id });

    return { kitId: kit.id, status: kit.status };
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

    await this.dependencies.kitRepository.addPracticeRecord(userId, kitId, {
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

  async addQuestion(userId: string, kitId: string, input: AddQuestionInput): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta, sequences) => {
      const requirementIds = new Set(kit.role.requirements.map((entry) => entry.id));
      const refs = [...new Set(input.requirement_ids ?? [])].filter((id) => requirementIds.has(id));

      if (refs.length === 0) {
        throw new BadRequestException('A question must reference a real requirement.');
      }

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
    });
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

  async deleteQuestion(userId: string, kitId: string, questionId: string): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta) => {
      if (!kit.questions.some((question) => question.id === questionId)) {
        throw new NotFoundException('Question not found');
      }

      kit.questions = kit.questions.filter((question) => question.id !== questionId);

      if (kit.questions.length === 0) {
        throw new BadRequestException('A kit must keep at least one question.');
      }

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
  ): Promise<InterviewKit> {
    return this.mutateKit(userId, kitId, (kit, meta, sequences) => {
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
    });
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
        throw new NotFoundException('Flashcard not found');
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

  async regenerate(
    userId: string,
    kitId: string,
    input: RegenerateSectionInput,
  ): Promise<InterviewKit> {
    const doc = await this.requireCompletedKit(userId, kitId);
    const content = structuredClone(doc.kit as InterviewKit);
    const meta: EditorMeta = structuredClone(doc.editorMeta ?? {});
    const sequences = { ...doc.idSequences };

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
        const brief = await this.dependencies.kitGeneration.generateBrief(
          content.role.title,
          content.role.requirements,
          context,
        );
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
        const fresh = await this.dependencies.kitGeneration.generateCategoryQuestions(
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

        // Dropped unedited questions leave the schedule; minutes follow the
        // same 30-minutes-per-question rule as initial allocation.
        const kept = new Set(content.questions.map((question) => question.id));

        for (const day of content.schedule.days) {
          day.question_ids = day.question_ids.filter((id) => kept.has(id));
          day.minutes = day.question_ids.length * 30;
        }

        content.coverage = {
          uncovered_requirement_ids: calculateCoverage(content.role.requirements, content.questions)
            .uncovered_requirement_ids,
          passes: content.coverage.passes,
        };
      }
    }

    const validated = this.dependencies.kitGeneration.validateEditedKit(content);
    const saved = await this.dependencies.kitRepository.saveEditedKit(
      userId,
      kitId,
      validated,
      sequences,
      meta,
    );

    if (!saved) {
      throw new NotFoundException('Kit not found');
    }

    return validated;
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
    const sequences = { ...doc.idSequences };

    const nextMeta = apply(content, meta, sequences);
    const validated = this.dependencies.kitGeneration.validateEditedKit(content);
    const saved = await this.dependencies.kitRepository.saveEditedKit(
      userId,
      kitId,
      validated,
      sequences,
      nextMeta,
    );

    if (!saved) {
      throw new NotFoundException('Kit not found');
    }

    return validated;
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
