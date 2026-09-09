import session, { type SessionOptions } from 'express-session';
import type { Redis } from 'ioredis';
import { IORedisSessionStore } from '@/infrastructure/session/ioredis-session.store';
import type { AppConfig } from '@/config/app.config';

export const createSessionMiddleware = (
  redisClient: Redis,
  config: AppConfig,
): ReturnType<typeof session> => {
  const options: SessionOptions = {
    store: new IORedisSessionStore(redisClient),
    resave: false,
    saveUninitialized: false,
    secret: config.sessionSecret,
    name: config.sessionCookieName,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
    },
  };

  return session(options);
};
