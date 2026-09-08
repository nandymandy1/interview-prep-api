import type { PaginateModel, PaginateResult } from 'mongoose';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { PaginatedResult, PaginationQuery } from '@/common/types/pagination.type';
import type { Kit, KitDocument, KitPracticeRecord } from '@/modules/kit/kit.model';

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
