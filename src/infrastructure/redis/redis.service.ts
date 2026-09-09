import { Redis, type RedisOptions } from 'ioredis';
import type { LoggerService } from '@/infrastructure/logger/logger.service';

type RedisServiceDependencies = {
  url: string;
  logger: LoggerService;
};

// The only direct Redis client in the codebase (ioredis, REDIS_URL only).
// One shared command connection; callers needing subscriber semantics use
// duplicate() and never reuse a subscriber-mode connection for commands.
export const createRedisConnection = (url: string, options: RedisOptions = {}): Redis =>
  new Redis(url, { lazyConnect: true, ...options });

export class RedisService {
  private readonly client: Redis;

  constructor(private readonly dependencies: RedisServiceDependencies) {
    this.client = createRedisConnection(dependencies.url);

    this.client.on('error', (error) => {
      this.dependencies.logger.error(error, 'redis.client.error');
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async connect(): Promise<void> {
    if (this.client.status === 'ready') {
      return;
    }

    await this.client.ping();
    this.dependencies.logger.info('redis.connected');
  }

  async disconnect(): Promise<void> {
    if (this.client.status === 'end') {
      return;
    }

    await this.client.quit();
    this.dependencies.logger.info('redis.disconnected');
  }
}
