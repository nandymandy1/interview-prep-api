import { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import type { CompanyResearchResult } from '@/modules/research/company-research.service';

// Small company-research reuse: same canonical company URL (+ research
// version + retrieval mode) may skip crawl + Brave, while requirement
// extraction and role questions always regenerate. Never fuzzy name
// matching; never user Kit documents.
export const RESEARCH_VERSION = 'v1';
export const RESEARCH_CACHE_TTL_HOURS = 24;

export type ResearchCacheRecord = {
  key: string;
  researchVersion: string;
  companyUrl: string;
  result: CompanyResearchResult;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type ResearchCacheDocument = HydratedDocument<ResearchCacheRecord>;

const researchCacheSchema = new Schema<ResearchCacheRecord>(
  {
    key: { type: String, required: true, unique: true },
    researchVersion: { type: String, required: true },
    companyUrl: { type: String, required: true },
    result: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true, versionKey: false },
);

export const ResearchCacheModel: Model<ResearchCacheRecord> = model<ResearchCacheRecord>(
  'ResearchCache',
  researchCacheSchema,
);
