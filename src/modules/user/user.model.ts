import { Schema, model, type HydratedDocument } from 'mongoose';

export type User = {
  email: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthenticationUser = User & {
  passwordHash: string;
};

export type UserDocument = HydratedDocument<User>;

export type AuthenticationUserDocument = HydratedDocument<AuthenticationUser>;

const userSchema = new Schema<AuthenticationUser>(
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
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const UserModel = model<AuthenticationUser>('User', userSchema);
