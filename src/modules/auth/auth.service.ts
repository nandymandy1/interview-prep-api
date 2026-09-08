import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@/common/errors/http-exception';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { UserDocument } from '@/modules/user/user.model';
import type { UserRepository } from '@/modules/user/user.repository';
import type { PublicUser } from '@/modules/user/user.type';
import type { AuthResult, LoginInput, RegisterInput } from '@/modules/auth/auth.type';
import type { PasswordService } from '@/modules/auth/password.service';

type AuthServiceDependencies = {
  userRepository: UserRepository;
  passwordService: PasswordService;
  logger: LoggerService;
};

export class AuthService {
  constructor(private readonly dependencies: AuthServiceDependencies) {}

  async register(input: RegisterInput): Promise<AuthResult> {
    const existingUser = await this.dependencies.userRepository.findByEmail(input.email);

    if (existingUser) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await this.dependencies.passwordService.hash(input.password);
    const user = await this.dependencies.userRepository.create(input.email, passwordHash);

    this.dependencies.logger.info('auth.user.registered', {
      userId: user.id,
    });

    return { user: this.toPublicUser(user) };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.dependencies.userRepository.findByEmail(input.email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await this.dependencies.passwordService.compare(
      input.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    this.dependencies.logger.info('auth.user.logged_in', {
      userId: user.id,
    });

    return { user: this.toPublicUser(user) };
  }

  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await this.dependencies.userRepository.findById(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toPublicUser(user);
  }

  private toPublicUser(user: UserDocument): PublicUser {
    return {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
