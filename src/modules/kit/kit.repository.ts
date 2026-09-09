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
  // high-water sequences together; never one without the others.
  async saveEditedKit(
    userId: string,
    kitId: string,
    kit: InterviewKit,
    sequences: KitIdSequences,
    editorMeta: EditorMeta,
  ): Promise<KitDocument | null> {
    return this.dependencies.kitModel.findOneAndUpdate(
      { _id: kitId, userId },
      { $set: { kit, idSequences: sequences, editorMeta } },
      { new: true },
    );
  }

  async addPracticeRecord(
    userId: string,
    kitId: string,
    record: Omit<KitPracticeRecord, 'recordedAt'>,
  ): Promise<KitDocument | null> {
    return this.dependencies.kitModel.findOneAndUpdate(
      { _id: kitId, userId },
      { $push: { practiceRecords: { ...record, recordedAt: new Date() } } },
      { new: true },
    );
  }
}
