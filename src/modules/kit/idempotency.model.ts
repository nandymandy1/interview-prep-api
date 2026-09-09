import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

// One tiny Mongo-backed idempotency mechanism for mutating kit operations
// (create-kit, regenerations, manual adds). Unique userId + operation + key;
// the Mongo unique constraint — never an in-memory map — arbitrates
// concurrent duplicate requests. TTL keeps the collection small.
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export type IdempotencyStatus = 'processing' | 'completed' | 'failed';

export type IdempotencyRecord = {
  userId: Types.ObjectId;
  key: string;
  operation: string;
  resourceId?: string;
  status: IdempotencyStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type IdempotencyDocument = HydratedDocument<IdempotencyRecord>;

const idempotencySchema = new Schema<IdempotencyRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true, maxlength: 128 },
    operation: { type: String, required: true, maxlength: 128 },
    resourceId: { type: String },
    status: { type: String, enum: ['processing', 'completed', 'failed'], required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true, versionKey: false },
);

idempotencySchema.index({ userId: 1, operation: 1, key: 1 }, { unique: true });

export const IdempotencyModel: Model<IdempotencyRecord> = model<IdempotencyRecord>(
  'IdempotencyRecord',
  idempotencySchema,
);
