import { Router, type RequestHandler } from 'express';
import type { Provider } from '@/common/providers/provider';
import type { WrapRoute } from '@/common/http/wrap-route';
import { validationMiddleware } from '@/common/middleware/validation.middleware';
import type { AuthController } from '@/modules/auth/auth.controller';
import { loginValidator, registerValidator } from '@/modules/auth/auth.validator';

export type AuthRouterDependencies = {
  authController: Provider<AuthController>;
  wrapRoute: WrapRoute;
  requireAuth: RequestHandler;
};

export const createAuthRouter = ({
  authController,
  wrapRoute,
  requireAuth,
}: AuthRouterDependencies): Router => {
  const router = Router();

  router.post(
    '/register',
    registerValidator,
    validationMiddleware,
    wrapRoute(authController, 'register', 'auth.register'),
  );

  router.post(
    '/login',
    loginValidator,
    validationMiddleware,
    wrapRoute(authController, 'login', 'auth.login'),
  );

  router.post('/logout', requireAuth, wrapRoute(authController, 'logout', 'auth.logout'));

  router.get('/me', requireAuth, wrapRoute(authController, 'me', 'auth.me'));

  return router;
};
