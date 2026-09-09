import type { RedisClientType } from 'redis';
import { BRAVE_MIN_REQUEST_INTERVAL_MS } from '@/modules/research/search/search.constants';

// One-method seam: every Brave HTTP attempt (initials and retries) passes
// through waitForSlot() before the request starts. Web/worker contexts share
// a Redis start gate; the evaluator uses the in-process gate instead.
export type BraveRequestGate = {
  waitForSlot(): Promise<void>;
};

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const randomToken = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// Serializes request starts inside one process. Keeps no timers running:
// it only sleeps the remaining gap when a previous start was recent.
export class InProcessBraveGate implements BraveRequestGate {
  private lastStart = 0;

  constructor(
    private readonly intervalMs: number = BRAVE_MIN_REQUEST_INTERVAL_MS,
    private readonly sleep: Sleep = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  async waitForSlot(): Promise<void> {
    const elapsed = this.now() - this.lastStart;

    if (elapsed < this.intervalMs) {
      await this.sleep(this.intervalMs - elapsed);
    }

    this.lastStart = this.now();
  }
}

type RedisBraveGateDependencies = {
  client: RedisClientType;
  key: string;
  intervalMs?: number;
  sleep?: Sleep;
};

// Distributed variant of the same contract: SET NX PX either starts the
// request now or reveals the holder's remaining TTL to sleep off. The TTL
// releases a dead holder automatically; no token bucket, no subqueue.
export class RedisBraveGate implements BraveRequestGate {
  private readonly key: string;
  private readonly intervalMs: number;
  private readonly sleep: Sleep;

  constructor(private readonly dependencies: RedisBraveGateDependencies) {
    this.key = dependencies.key;
    this.intervalMs = dependencies.intervalMs ?? BRAVE_MIN_REQUEST_INTERVAL_MS;
    this.sleep = dependencies.sleep ?? defaultSleep;
  }

  async waitForSlot(): Promise<void> {
    const { client } = this.dependencies;

    for (;;) {
      const acquired = await client.set(this.key, randomToken(), {
        PX: this.intervalMs,
        NX: true,
      });

      if (acquired !== null) {
        return;
      }

      const ttl = await client.pTTL(this.key);
      await this.sleep(ttl > 0 ? ttl : this.intervalMs);
    }
  }
}
