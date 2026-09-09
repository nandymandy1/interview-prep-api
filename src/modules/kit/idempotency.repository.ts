import type { Model } from 'mongoose';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type {
  IdempotencyDocument,
  IdempotencyRecord,
  IdempotencyStatus,
} from '@/modules/kit/idempotency.model';
import { IDEMPOTENCY_TTL_SECONDS } from '@/modules/kit/idempotency.model';

type IdempotencyRepositoryDependencies = {
  idempotencyModel: Model<IdempotencyRecord>;
  logger: LoggerService;
};

// Claim-before-side-effects helper. claim() inserts a processing record and
// returns it; a duplicate-key error means a concurrent duplicate won the
// race — the caller must read the existing record and replay it instead.
// complete()/fail() transition owned records; replaying a failed record
// re-claims it so the same key can safely retry after a failure.
export class IdempotencyRepository {
  constructor(private readonly dependencies: IdempotencyRepositoryDependencies) {}

  async claim(
    userId: string,
    operation: string,
    key: string,
  ): Promise<{ claimed: true; record: IdempotencyDocument } | { claimed: false }> {
    try {
      const record = await this.dependencies.idempotencyModel.create({
        userId,
        key,
        operation,
        status: 'processing' satisfies IdempotencyStatus,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000),
      });

      return { claimed: true, record };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return { claimed: false };
      }

      throw error;
    }
  }

  async find(userId: string, operation: string, key: string): Promise<IdempotencyDocument | null> {
    return this.dependencies.idempotencyModel.findOne({ userId, operation, key });
  }

  async attachResource(
    userId: string,
    operation: string,
    key: string,
    resourceId: string,
  ): Promise<void> {
    await this.dependencies.idempotencyModel.updateOne(
      { userId, operation, key, status: 'processing' },
      { $set: { resourceId } },
    );
  }

  async complete(userId: string, operation: string, key: string): Promise<void> {
    await this.dependencies.idempotencyModel.updateOne(
      { userId, operation, key },
      { $set: { status: 'completed' satisfies IdempotencyStatus } },
    );
  }

  async fail(userId: string, operation: string, key: string): Promise<void> {
    await this.dependencies.idempotencyModel.updateOne(
      { userId, operation, key, status: 'processing' },
      { $set: { status: 'failed' satisfies IdempotencyStatus } },
    );
  }
}

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 11000;
