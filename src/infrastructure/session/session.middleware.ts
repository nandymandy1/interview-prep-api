import session, { type SessionOptions } from 'express-session';
import { RedisStore } from 'connect-redis';
import type { RedisClientType } from 'redis';
import type { AppConfig } from '../../config/app.config';

export const createSessionMiddleware = (
  redisClient: RedisClientType,
  config: AppConfig,
): ReturnType<typeof session> => {
  const options: SessionOptions = {
    store: new RedisStore({
      client: redisClient,
      prefix: 'session:',
    }),
    resave: false,
    saveUninitialized: false,
    secret: config.sessionSecret,
    name: config.sessionCookieName,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7,
      secure: config.nodeEnv === 'production',
      sameSite: config.nodeEnv === 'production' ? 'none' : 'lax',
    },
  };

  return session(options);
};
