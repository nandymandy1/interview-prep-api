import mongoose from 'mongoose';
import type { LoggerService } from '../logger/logger.service';

type MongoDatabaseServiceDependencies = {
  uri: string;
  logger: LoggerService;
};

export class MongoDatabaseService {
  constructor(private readonly dependencies: MongoDatabaseServiceDependencies) {}

  async connect(): Promise<void> {
    if (mongoose.connection.readyState === 1) {
      return;
    }

    await mongoose.connect(this.dependencies.uri);
    this.dependencies.logger.info('database.mongo.connected');
  }

  async disconnect(): Promise<void> {
    if (mongoose.connection.readyState === 0) {
      return;
    }

    await mongoose.disconnect();
    this.dependencies.logger.info('database.mongo.disconnected');
  }
}
