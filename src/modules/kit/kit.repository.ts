import type { PaginateModel, PaginateResult } from 'mongoose';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { PaginatedResult, PaginationQuery } from '@/common/types/pagination.type';
import type { EditorMeta, Kit, KitDocument, KitPracticeRecord } from '@/modules/kit/kit.model';
import type { KitStatus } from '@/modules/kit/kit-api.type';
import type { InterviewKit } from '@/modules/kit/kit.type';
import type { KitIdSequences } from '@/modules/kit/kit-id.type';

type KitRepositoryDependencies = {
  kitModel: PaginateModel<Kit>;
  logger: LoggerService;
};

export type CreateKitRecord = {
  userId: string;
  jd: string;
  companyUrl: string;
  days: number;
};

export type GenerationStateUpdate = {
  status?: KitStatus;
  stage?: string;
  stageMessage?: string;
  error?: { code: string; message: string } | null;
};

export class KitRepository {
  constructor(private readonly dependencies: KitRepositoryDependencies) {}

  async create(record: CreateKitRecord): Promise<KitDocument> {
    const kit = await this.dependencies.kitModel.create({
      userId: record.userId,
      status: 'queued',
      input: { jd: record.jd, companyUrl: record.companyUrl, days: record.days },
    });

    this.dependencies.logger.debug('kit.repository.created', {
      userId: record.userId,
      kitId: kit.id,
    });

    return kit;
  }

  async findByUserPaginated(
    userId: string,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<KitDocument>> {
    const result: PaginateResult<KitDocument> = await this.dependencies.kitModel.paginate(
      { userId },
      {
        page: pagination.page,
        limit: pagination.limit,
        sort: { createdAt: -1, _id: -1 },
      },
    );

    return {
      items: result.docs,
      pagination: {
        page: result.page ?? pagination.page,
        limit: result.limit,
        totalItems: result.totalDocs,
        totalPages: result.totalPages,
        hasNextPage: result.hasNextPage,
        hasPrevPage: result.hasPrevPage,
        nextPage: result.nextPage ?? null,
        prevPage: result.prevPage ?? null,
      },
    };
  }

  async findOwnedById(userId: string, kitId: string): Promise<KitDocument | null> {
    return this.dependencies.kitModel.findOne({ _id: kitId, userId });
  }

  // Single owner-scoped writer for every generation stage transition. The
  // worker persists here; Mongo stays the source of truth for GET /status.
  async updateGenerationState(
    userId: string,
    kitId: string,
    update: GenerationStateUpdate,
  ): Promise<KitDocument | null> {
    return this.dependencies.kitModel.findOneAndUpdate(
      { _id: kitId, userId },
      {
        $set: {
          ...(update.status !== undefined ? { status: update.status } : {}),
          ...(update.stage !== undefined ? { stage: update.stage } : {}),
          ...(update.stageMessage !== undefined ? { stageMessage: update.stageMessage } : {}),
          ...(update.error !== undefined ? { error: update.error } : {}),
        },
      },
      { new: true },
    );
  }

  async saveGeneratedKit(
    userId: string,
    kitId: string,
    kit: InterviewKit,
    sequences: KitIdSequences,
  ): Promise<KitDocument | null> {
    return this.dependencies.kitModel.findOneAndUpdate(
      { _id: kitId, userId },
      {
        $set: {
          status: 'completed',
          stage: 'completed',
          stageMessage: 'Kit completed.',
          error: null,
          kit,
          idSequences: sequences,
        },
      },
      { new: true },
    );
  }

  // Builder mutations persist the canonical kit plus editor metadata and the
  // high-water sequences together; never one without the others. Pass the
  // version the caller read: a stale write matches nothing (returns null) so
  // the service can answer 409 instead of clobbering a concurrent edit.
  async saveEditedKit(
    userId: string,
    kitId: string,
    kit: InterviewKit,
    sequences: KitIdSequences,
    editorMeta: EditorMeta,
    expectedVersion?: number,
  ): Promise<KitDocument | null> {
    return this.dependencies.kitModel.findOneAndUpdate(
      {
        _id: kitId,
        userId,
        ...(expectedVersion !== undefined ? { __v: expectedVersion } : {}),
      },
      { $set: { kit, idSequences: sequences, editorMeta }, $inc: { __v: 1 } },
      { new: true },
    );
  }

  // Practice state is SET semantics per flashcard: repeating the same
  // confidence PATCH leaves exactly ONE logical record, never a duplicate
  // from a transport retry.
  async setPracticeConfidence(
    userId: string,
    kitId: string,
    record: Omit<KitPracticeRecord, 'recordedAt'>,
  ): Promise<KitDocument | null> {
    const updated = await this.dependencies.kitModel.findOneAndUpdate(
      { _id: kitId, userId, 'practiceRecords.flashcardId': record.flashcardId },
      {
        $set: {
          'practiceRecords.$.confidence': record.confidence,
          'practiceRecords.$.recordedAt': new Date(),
        },
      },
      { new: true },
    );

    if (updated) {
      return updated;
    }

    return this.dependencies.kitModel.findOneAndUpdate(
      { _id: kitId, userId, 'practiceRecords.flashcardId': { $ne: record.flashcardId } },
      { $push: { practiceRecords: { ...record, recordedAt: new Date() } } },
      { new: true },
    );
  }
}
