import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  requestId: string;
  method: string;
  path: string;
  startedAt: number;
  userId?: string;
};

export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  get(): RequestContext | undefined {
    return this.storage.getStore();
  }

  setUserId(userId: string): void {
    const context = this.storage.getStore();

    if (context) {
      context.userId = userId;
    }
  }
}
