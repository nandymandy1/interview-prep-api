import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import {
  GENERATION_VERSION,
  normalizeJd,
  type CachedGeneration,
  type GenerationCacheStore,
} from '@/modules/generation/generation-fingerprint';
import type { GenerationCacheRecord } from '@/modules/generation/generation-cache.model';
import { GENERATION_CACHE_TTL_DAYS } from '@/modules/generation/generation-cache.model';

type GenerationCacheRepositoryDependencies = {
  generationCacheModel: Model<GenerationCacheRecord>;
  ttlDays?: number;
  logger: LoggerService;
};

// Mongo-backed exact-input store. findFresh returns null on miss, expiry, or
// version mismatch — the caller validates content shape itself before reuse.
export class GenerationCacheRepository implements GenerationCacheStore {
  constructor(private readonly dependencies: GenerationCacheRepositoryDependencies) {}

  async findFresh(fingerprint: string): Promise<CachedGeneration | null> {
    const record = await this.dependencies.generationCacheModel.findOne({ fingerprint }).lean();

    if (!record) {
      return null;
    }

    if (record.generationVersion !== GENERATION_VERSION) {
      return null;
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return { fingerprint: record.fingerprint, content: record.content };
  }

  async upsert(input: {
    fingerprint: string;
    jd: string;
    companyUrl: string;
    content: CachedGeneration['content'];
  }): Promise<void> {
    const ttlDays = this.dependencies.ttlDays ?? GENERATION_CACHE_TTL_DAYS;

    await this.dependencies.generationCacheModel.updateOne(
      { fingerprint: input.fingerprint },
      {
        $set: {
          generationVersion: GENERATION_VERSION,
          companyUrl: input.companyUrl,
          jdHash: createHash('sha256').update(normalizeJd(input.jd)).digest('hex'),
          content: input.content,
          expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
        },
      },
      { upsert: true },
    );
  }
}
