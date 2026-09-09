import type { Model } from 'mongoose';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { CompanyResearchResult } from '@/modules/research/company-research.service';
import type { ResearchCacheRecord } from '@/modules/research/research-cache.model';
import {
  RESEARCH_CACHE_TTL_HOURS,
  RESEARCH_VERSION,
} from '@/modules/research/research-cache.model';
import type { ResearchCacheStore } from '@/modules/research/research-cache';

type ResearchCacheRepositoryDependencies = {
  researchCacheModel: Model<ResearchCacheRecord>;
  ttlHours?: number;
  logger: LoggerService;
};

// Mongo-backed company-research reuse. findFresh returns null on miss,
// expiry, or version mismatch. Writes are best-effort at the call site.
export class ResearchCacheRepository implements ResearchCacheStore {
  constructor(private readonly dependencies: ResearchCacheRepositoryDependencies) {}

  async findFresh(key: string): Promise<CompanyResearchResult | null> {
    const record = await this.dependencies.researchCacheModel.findOne({ key }).lean();

    if (!record) {
      return null;
    }

    if (record.researchVersion !== RESEARCH_VERSION) {
      return null;
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return record.result;
  }

  async store(key: string, result: CompanyResearchResult): Promise<void> {
    const ttlHours = this.dependencies.ttlHours ?? RESEARCH_CACHE_TTL_HOURS;

    await this.dependencies.researchCacheModel.updateOne(
      { key },
      {
        $set: {
          researchVersion: RESEARCH_VERSION,
          companyUrl: result.companyUrl,
          result,
          expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
        },
      },
      { upsert: true },
    );
  }
}
