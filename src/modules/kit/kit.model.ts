import { Schema, model, type HydratedDocument, type PaginateModel, type Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import type { KitStatus } from '@/modules/kit/kit-api.type';
import type { InterviewKit } from '@/modules/kit/kit.type';

export type KitInput = {
  jd: string;
  companyUrl: string;
  days: number;
};

export type KitPracticeRecord = {
  flashcardId: string;
  confidence: number;
  recordedAt: Date;
};

// Editor metadata lives outside the canonical InterviewKit (whose strict
// schema rejects it): pinned/edited/manual flags per question ID plus the
// company-brief fields the user edited. Regeneration preserves them.
export type EditorQuestionMeta = {
  pinned?: boolean;
  edited?: boolean;
  manual?: boolean;
};

export type EditorMeta = {
  questions?: Record<string, EditorQuestionMeta>;
  briefFields?: string[];
};

export type Kit = {
  userId: Types.ObjectId;
  status: KitStatus;
  stage: string;
  stageMessage?: string;
  error?: { code: string; message: string };
  input: KitInput;
  kit: InterviewKit | null;
  idSequences: {
    requirement: number;
    question: number;
    flashcard: number;
  };
  editorMeta: EditorMeta;
  practiceRecords: KitPracticeRecord[];
  createdAt: Date;
  updatedAt: Date;
};

export type KitDocument = HydratedDocument<Kit>;

const idSequencesSchema = new Schema(
  {
    requirement: { type: Number, default: 0 },
    question: { type: Number, default: 0 },
    flashcard: { type: Number, default: 0 },
  },
  { _id: false },
);

const practiceRecordSchema = new Schema(
  {
    flashcardId: { type: String, required: true },
    confidence: { type: Number, required: true, min: 1, max: 5 },
    recordedAt: { type: Date, required: true },
  },
  { _id: false },
);

const kitSchema = new Schema<Kit>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed'],
      required: true,
    },
    stage: { type: String, default: 'queued' },
    stageMessage: { type: String },
    error: {
      type: new Schema({ code: String, message: String }, { _id: false }),
      required: false,
    },
    input: {
      jd: { type: String, required: true },
      companyUrl: { type: String, required: true },
      days: { type: Number, required: true, min: 1, max: 60 },
    },
    kit: { type: Schema.Types.Mixed, default: null },
    idSequences: {
      type: idSequencesSchema,
      default: () => ({}),
    },
    editorMeta: { type: Schema.Types.Mixed, default: () => ({}) },
    practiceRecords: { type: [practiceRecordSchema], default: [] },
  },
  {
    timestamps: true,
    // __v stays enabled on purpose: builder mutations pass the version they
    // read, and a stale write becomes a structured 409 instead of silently
    // clobbering another edit. __v never enters the canonical InterviewKit.
    optimisticConcurrency: true,
  },
);

kitSchema.index({ userId: 1, updatedAt: -1 });
kitSchema.index({ userId: 1, createdAt: -1 });

kitSchema.plugin(mongoosePaginate);

export const KitModel: PaginateModel<Kit> = model<Kit, PaginateModel<Kit>>('Kit', kitSchema);
