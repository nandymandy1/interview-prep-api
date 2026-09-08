import { Router } from 'express';
import type { Provider } from '@/common/providers/provider';
import type { WrapRoute } from '@/common/http/wrap-route';
import type { HealthController } from '@/modules/health/health.controller';

export type HealthRouterDependencies = {
  healthController: Provider<HealthController>;
  wrapRoute: WrapRoute;
};

export const createHealthRouter = ({
  healthController,
  wrapRoute,
}: HealthRouterDependencies): Router => {
  const router = Router();

  router.get('/', wrapRoute(healthController, 'getHealth', 'health.get'));

  return router;
};
