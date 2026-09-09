import { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import type { PristineGeneratedContent } from '@/modules/generation/generation-fingerprint';

// Exact-input generation reuse: pristine generated material keyed by the
// deterministic fingerprint (generation version + canonical company URL +
// normalized JD). NEVER userId ownership, manual edits, editor metadata,
// practice confidence, or user-specific schedule state. TTL bounds freshness;
// expired entries are a miss and get replaced.
export const GENERATION_CACHE_TTL_DAYS = 7;

export type GenerationCacheRecord = {
  fingerprint: string;
  generationVersion: string;
  companyUrl: string;
  jdHash: string;
  content: PristineGeneratedContent;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type GenerationCacheDocument = HydratedDocument<GenerationCacheRecord>;

const generationCacheSchema = new Schema<GenerationCacheRecord>(
  {
    fingerprint: { type: String, required: true, unique: true },
    generationVersion: { type: String, required: true },
    companyUrl: { type: String, required: true },
    jdHash: { type: String, required: true },
    content: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true, versionKey: false },
);

export const GenerationCacheModel: Model<GenerationCacheRecord> = model<GenerationCacheRecord>(
  'GenerationCache',
  generationCacheSchema,
);
