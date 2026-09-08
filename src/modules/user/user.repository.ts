import type { Model } from 'mongoose';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { User, UserDocument } from '@/modules/user/user.model';

type UserRepositoryDependencies = {
  userModel: Model<User>;
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
    return this.dependencies.userModel.findOne({
      email: email.toLowerCase(),
    });
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.dependencies.userModel.findById(id);
  }
}
