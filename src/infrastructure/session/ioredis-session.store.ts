import { Store } from 'express-session';
import type { SessionData } from 'express-session';
import type { Redis } from 'ioredis';

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const sessionKey = (sid: string): string => `session:${sid}`;

// Minimal express-session store on the shared ioredis connection. Only the
// get/set/destroy/touch surface express-session actually calls; JSON payload
// with PX expiry mirrors the previous RedisStore behavior.
export class IORedisSessionStore extends Store {
  constructor(private readonly client: Redis) {
    super();
  }

  override get(
    sid: string,
    callback: (error: unknown, session?: SessionData | null) => void,
  ): void {
    this.client
      .get(sessionKey(sid))
      .then((raw) => {
        if (!raw) {
          callback(null, null);
          return;
        }

        try {
          callback(null, JSON.parse(raw) as SessionData);
        } catch (error) {
          callback(error);
        }
      })
      .catch((error: unknown) => callback(error));
  }

  override set(
    sid: string,
    session: SessionData,
    callback: (error?: unknown) => void = () => undefined,
  ): void {
    const ttl = session.cookie?.maxAge ?? DEFAULT_TTL_MS;
    this.client
      .set(sessionKey(sid), JSON.stringify(session), 'PX', Math.max(ttl, 1000))
      .then(() => callback())
      .catch((error: unknown) => callback(error));
  }

  override destroy(sid: string, callback: (error?: unknown) => void = () => undefined): void {
    this.client
      .del(sessionKey(sid))
      .then(() => callback())
      .catch((error: unknown) => callback(error));
  }

  override touch(
    sid: string,
    session: SessionData,
    callback: (error?: unknown) => void = () => undefined,
  ): void {
    const ttl = session.cookie?.maxAge ?? DEFAULT_TTL_MS;
    this.client
      .pexpire(sessionKey(sid), Math.max(ttl, 1000))
      .then(() => callback())
      .catch((error: unknown) => callback(error));
  }
}
