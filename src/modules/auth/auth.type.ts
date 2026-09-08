import type { PublicUser } from '@/modules/user/user.type';

export type RegisterInput = {
  email: string;
  password: string;
};

export type LoginInput = RegisterInput;

export type AuthResult = {
  user: PublicUser;
};
