import type { Model } from 'mongoose';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type {
  AuthenticationUser,
  AuthenticationUserDocument,
  UserDocument,
} from '@/modules/user/user.model';

type UserRepositoryDependencies = {
  userModel: Model<AuthenticationUser>;
  logger: LoggerService;
};

export class UserRepository {
  constructor(private readonly dependencies: UserRepositoryDependencies) {}

  async create(email: string, passwordHash: string): Promise<UserDocument> {
    const user = await this.dependencies.userModel.create({
      email: email.toLowerCase(),
      passwordHash,
    });

    this.dependencies.logger.debug('user.repository.created', {
      userId: user.id,
    });

    return user;
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    const user = await this.dependencies.userModel.findOne({ email: email.toLowerCase() });
    return user as unknown as UserDocument | null;
  }

  async findByEmailForAuthentication(email: string): Promise<AuthenticationUserDocument | null> {
    return this.dependencies.userModel
      .findOne({ email: email.toLowerCase() })
      .select('+passwordHash');
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.dependencies.userModel.findById(id);
  }
}
