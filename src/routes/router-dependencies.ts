import type { AppContainer } from '../container/app-container';
import type { AuthRouterDependencies } from '../modules/auth/auth.router';
import type { HealthRouterDependencies } from '../modules/health/health.router';

export type RouterDependencies = {
  auth: AuthRouterDependencies;
  health: HealthRouterDependencies;
};

export const createRouterDependencies = (
  container: AppContainer,
): RouterDependencies => ({
  auth: {
    authController: container.authController,
    wrapRoute: container.wrapRoute(),
    requireAuth: container.requireAuth(),
  },
  health: {
    healthController: container.healthController,
    wrapRoute: container.wrapRoute(),
  },
});
