import { Schema, model, type HydratedDocument } from 'mongoose';

export type User = {
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
};

export type UserDocument = HydratedDocument<User>;

const userSchema = new Schema<User>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const UserModel = model<User>('User', userSchema);
