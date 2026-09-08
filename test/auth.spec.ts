import type { Request, Response } from 'express';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, UnauthorizedException } from '@/common/errors/http-exception';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import { AuthController } from '@/modules/auth/auth.controller';
import { AuthService } from '@/modules/auth/auth.service';
import type { PasswordService } from '@/modules/auth/password.service';
import type {
  AuthenticationUser,
  AuthenticationUserDocument,
  User,
  UserDocument,
} from '@/modules/user/user.model';
import { UserRepository } from '@/modules/user/user.repository';

const logger = () => ({ info: vi.fn(), debug: vi.fn() }) as unknown as LoggerService;

const userRepository = () =>
  ({
    findByEmail: vi.fn(),
    findByEmailForAuthentication: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
  }) as unknown as UserRepository & {
    findByEmail: ReturnType<typeof vi.fn>;
    findByEmailForAuthentication: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };

const passwordService = () =>
  ({ hash: vi.fn(), compare: vi.fn() }) as unknown as PasswordService & {
    hash: ReturnType<typeof vi.fn>;
    compare: ReturnType<typeof vi.fn>;
  };

const storedUser = (overrides: Partial<User> = {}) =>
  ({
    id: 'u1',
    email: 'a@b.c',
    passwordHash: 'hash',
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
    ...overrides,
  }) as unknown as UserDocument;

describe('user lookup hash selection', () => {
  it('findByEmail does not select passwordHash', async () => {
    const select = vi.fn();
    const model = {
      findOne: vi.fn().mockReturnValue({ select }),
    } as unknown as Model<AuthenticationUser>;
    const repository = new UserRepository({ userModel: model, logger: logger() });

    await repository.findByEmail('A@B.c');

    expect(model.findOne).toHaveBeenCalledWith({ email: 'a@b.c' });
    expect(select).not.toHaveBeenCalled();
  });

  it('findByEmailForAuthentication explicitly selects passwordHash', async () => {
    const user = storedUser();
    const select = vi.fn().mockReturnValue(user);
    const model = {
      findOne: vi.fn().mockReturnValue({ select }),
    } as unknown as Model<AuthenticationUser>;
    const repository = new UserRepository({ userModel: model, logger: logger() });

    await expect(repository.findByEmailForAuthentication('A@B.c')).resolves.toBe(user);
    expect(model.findOne).toHaveBeenCalledWith({ email: 'a@b.c' });
    expect(select).toHaveBeenCalledWith('+passwordHash');
  });
});

describe('user return-type boundary', () => {
  it('ordinary user documents do not guarantee passwordHash', () => {
    const user: UserDocument = storedUser();
    // @ts-expect-error passwordHash is only guaranteed on authentication documents
    void user.passwordHash;
    const email: string = user.email;
    expect(email).toBe('a@b.c');
  });

  it('authentication documents guarantee passwordHash', () => {
    const user: AuthenticationUserDocument = storedUser() as unknown as AuthenticationUserDocument;
    const hash: string = user.passwordHash;
    expect(hash).toBe('hash');
  });
});

describe('auth service lookups', () => {
  it('login uses the authentication lookup, not the ordinary lookup', async () => {
    const repository = userRepository();
    const passwords = passwordService();
    repository.findByEmailForAuthentication.mockResolvedValue(storedUser());
    passwords.compare.mockResolvedValue(true);
    const service = new AuthService({
      userRepository: repository,
      passwordService: passwords,
      logger: logger(),
    });

    await service.login({ email: 'a@b.c', password: 'secret' });

    expect(repository.findByEmailForAuthentication).toHaveBeenCalledWith('a@b.c');
    expect(repository.findByEmail).not.toHaveBeenCalled();
  });

  it('login rejects unknown users and wrong passwords without leaking which', async () => {
    const repository = userRepository();
    const passwords = passwordService();
    const service = new AuthService({
      userRepository: repository,
      passwordService: passwords,
      logger: logger(),
    });

    repository.findByEmailForAuthentication.mockResolvedValue(null);
    await expect(service.login({ email: 'a@b.c', password: 'x' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    repository.findByEmailForAuthentication.mockResolvedValue(storedUser());
    passwords.compare.mockResolvedValue(false);
    await expect(service.login({ email: 'a@b.c', password: 'x' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('registration uses the ordinary existence lookup', async () => {
    const repository = userRepository();
    const passwords = passwordService();
    repository.findByEmail.mockResolvedValue(null);
    repository.create.mockResolvedValue(storedUser());
    passwords.hash.mockResolvedValue('hash');
    const service = new AuthService({
      userRepository: repository,
      passwordService: passwords,
      logger: logger(),
    });

    await service.register({ email: 'a@b.c', password: 'secret' });

    expect(repository.findByEmail).toHaveBeenCalledWith('a@b.c');
    expect(repository.findByEmailForAuthentication).not.toHaveBeenCalled();
  });

  it('duplicate existing user maps to 409', async () => {
    const repository = userRepository();
    repository.findByEmail.mockResolvedValue(storedUser());
    const service = new AuthService({
      userRepository: repository,
      passwordService: passwordService(),
      logger: logger(),
    });

    const error = await service
      .register({ email: 'a@b.c', password: 'secret' })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).statusCode).toBe(409);
  });

  it('database duplicate-key race maps to 409', async () => {
    const repository = userRepository();
    repository.findByEmail.mockResolvedValue(null);
    repository.create.mockRejectedValue({
      code: 11000,
      keyPattern: { email: 1 },
      message: 'E11000 duplicate key error',
    });
    const service = new AuthService({
      userRepository: repository,
      passwordService: { hash: vi.fn().mockResolvedValue('hash') } as unknown as PasswordService,
      logger: logger(),
    });

    const error = await service
      .register({ email: 'a@b.c', password: 'secret' })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).statusCode).toBe(409);
  });

  it('email keyValue duplicate-key race maps to 409', async () => {
    const repository = userRepository();
    repository.findByEmail.mockResolvedValue(null);
    repository.create.mockRejectedValue({
      code: 11000,
      keyValue: { email: 'a@b.c' },
      message: 'E11000 duplicate key error',
    });
    const service = new AuthService({
      userRepository: repository,
      passwordService: { hash: vi.fn().mockResolvedValue('hash') } as unknown as PasswordService,
      logger: logger(),
    });

    const error = await service
      .register({ email: 'a@b.c', password: 'secret' })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).statusCode).toBe(409);
  });

  it('non-email duplicate-key errors are not converted to email conflict', async () => {
    const repository = userRepository();
    repository.findByEmail.mockResolvedValue(null);
    repository.create.mockRejectedValue({
      code: 11000,
      keyPattern: { username: 1 },
      keyValue: { username: 'taken' },
      message: 'E11000 duplicate key error',
    });
    const service = new AuthService({
      userRepository: repository,
      passwordService: { hash: vi.fn().mockResolvedValue('hash') } as unknown as PasswordService,
      logger: logger(),
    });

    const error = await service
      .register({ email: 'a@b.c', password: 'secret' })
      .catch((error: unknown) => error);
    expect(error).not.toBeInstanceOf(ConflictException);
    expect((error as { code?: unknown }).code).toBe(11000);
  });

  it('unrelated database errors are not mislabeled 409', async () => {
    const repository = userRepository();
    repository.findByEmail.mockResolvedValue(null);
    repository.create.mockRejectedValue(new Error('connection reset'));
    const service = new AuthService({
      userRepository: repository,
      passwordService: { hash: vi.fn().mockResolvedValue('hash') } as unknown as PasswordService,
      logger: logger(),
    });

    await expect(service.register({ email: 'a@b.c', password: 'secret' })).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('authenticated session establishment', () => {
  it('regenerates the session before persisting identity', async () => {
    const order: string[] = [];
    const store: Record<string, unknown> = {};
    Object.defineProperty(store, 'userId', {
      set: (value: unknown) => {
        order.push('set-userId');
        store['value'] = value;
      },
      get: () => store['value'],
      configurable: true,
    });
    const session = Object.assign(store, {
      regenerate: (callback: (error: null) => void) => {
        order.push('regenerate');
        callback(null);
      },
      save: (callback: (error: null) => void) => {
        order.push('save');
        callback(null);
      },
    });
    const service = {
      register: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
    } as unknown as AuthService;
    const controller = new AuthController({ authService: service });
    const req = {
      body: { email: 'a@b.c', password: 'secret' },
      session,
      app: { get: vi.fn().mockReturnValue('sessionCookie') },
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await controller.register(req, res);

    expect(order).toEqual(['regenerate', 'set-userId', 'save']);
    expect(session['value']).toBe('u1');
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
