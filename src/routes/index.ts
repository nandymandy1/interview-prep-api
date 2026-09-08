import type { Express } from 'express';
import type { RouterDependencies } from '@/routes/router-dependencies';
import { createAuthRouter } from '@/modules/auth/auth.router';
import { createHealthRouter } from '@/modules/health/health.router';
import { createKitRouter } from '@/modules/kit/kit.router';

export const registerRoutes = (app: Express, dependencies: RouterDependencies): void => {
  app.use('/health', createHealthRouter(dependencies.health));
  app.use('/api/auth', createAuthRouter(dependencies.auth));
  app.use('/api/kits', createKitRouter(dependencies.kit));
};
