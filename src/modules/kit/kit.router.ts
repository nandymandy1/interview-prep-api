import { Router, type RequestHandler } from 'express';
import type { Provider } from '@/common/providers/provider';
import type { WrapRoute } from '@/common/http/wrap-route';
import { validationMiddleware } from '@/common/middleware/validation.middleware';
import type { KitController } from '@/modules/kit/kit.controller';
import {
  createKitValidator,
  kitIdParamValidator,
  listKitsValidator,
  recordPracticeValidator,
} from '@/modules/kit/kit-http.validator';

export type KitRouterDependencies = {
  kitController: Provider<KitController>;
  wrapRoute: WrapRoute;
  requireAuth: RequestHandler;
};

export const createKitRouter = ({
  kitController,
  wrapRoute,
  requireAuth,
}: KitRouterDependencies): Router => {
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    listKitsValidator,
    validationMiddleware,
    wrapRoute(kitController, 'list', 'kit.list'),
  );

  router.post(
    '/',
    createKitValidator,
    validationMiddleware,
    wrapRoute(kitController, 'create', 'kit.create'),
  );

  router.get(
    '/:kitId',
    kitIdParamValidator,
    validationMiddleware,
    wrapRoute(kitController, 'getById', 'kit.getById'),
  );

  router.get(
    '/:kitId/status',
    kitIdParamValidator,
    validationMiddleware,
    wrapRoute(kitController, 'getStatus', 'kit.getStatus'),
  );

  router.patch(
    '/:kitId/practice/:flashcardId',
    recordPracticeValidator,
    validationMiddleware,
    wrapRoute(kitController, 'recordPractice', 'kit.recordPractice'),
  );

  return router;
};

// Deferred until their domain behavior exists: regenerate, question
// update/reorder/delete. Their frontend hooks stay unregistered rather than
// backed by fabricated responses.
