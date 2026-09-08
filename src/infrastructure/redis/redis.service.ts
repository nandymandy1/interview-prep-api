import { createClient, type RedisClientType } from 'redis';
import type { LoggerService } from '../logger/logger.service';

type RedisServiceDependencies = {
  url: string;
  logger: LoggerService;
};

export class RedisService {
  private readonly client: RedisClientType;

  constructor(private readonly dependencies: RedisServiceDependencies) {
    this.client = createClient({ url: dependencies.url });

    this.client.on('error', (error) => {
      this.dependencies.logger.error(error, 'redis.client.error');
    });
  }

  getClient(): RedisClientType {
    return this.client;
  }

  async connect(): Promise<void> {
    if (this.client.isOpen) {
      return;
    }

    await this.client.connect();
    this.dependencies.logger.info('redis.connected');
  }

  async disconnect(): Promise<void> {
    if (!this.client.isOpen) {
      return;
    }

    await this.client.quit();
    this.dependencies.logger.info('redis.disconnected');
  }
}
