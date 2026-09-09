import { Router, type RequestHandler } from 'express';
import type { Provider } from '@/common/providers/provider';
import type { WrapRoute } from '@/common/http/wrap-route';
import { validationMiddleware } from '@/common/middleware/validation.middleware';
import type { KitController } from '@/modules/kit/kit.controller';
import {
  addFlashcardValidator,
  addQuestionValidator,
  createKitValidator,
  deleteFlashcardValidator,
  deleteQuestionValidator,
  kitIdParamValidator,
  listKitsValidator,
  recordPracticeValidator,
  regenerateValidator,
  reorderQuestionsValidator,
  updateBriefValidator,
  updateFlashcardValidator,
  updateQuestionValidator,
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

  router.patch(
    '/:kitId/questions/:questionId',
    updateQuestionValidator,
    validationMiddleware,
    wrapRoute(kitController, 'updateQuestion', 'kit.updateQuestion'),
  );

  router.post(
    '/:kitId/questions',
    addQuestionValidator,
    validationMiddleware,
    wrapRoute(kitController, 'addQuestion', 'kit.addQuestion'),
  );

  router.post(
    '/:kitId/questions/reorder',
    reorderQuestionsValidator,
    validationMiddleware,
    wrapRoute(kitController, 'reorderQuestions', 'kit.reorderQuestions'),
  );

  router.delete(
    '/:kitId/questions/:questionId',
    deleteQuestionValidator,
    validationMiddleware,
    wrapRoute(kitController, 'deleteQuestion', 'kit.deleteQuestion'),
  );

  router.post(
    '/:kitId/flashcards',
    addFlashcardValidator,
    validationMiddleware,
    wrapRoute(kitController, 'addFlashcard', 'kit.addFlashcard'),
  );

  router.patch(
    '/:kitId/flashcards/:flashcardId',
    updateFlashcardValidator,
    validationMiddleware,
    wrapRoute(kitController, 'updateFlashcard', 'kit.updateFlashcard'),
  );

  router.delete(
    '/:kitId/flashcards/:flashcardId',
    deleteFlashcardValidator,
    validationMiddleware,
    wrapRoute(kitController, 'deleteFlashcard', 'kit.deleteFlashcard'),
  );

  router.patch(
    '/:kitId/brief',
    updateBriefValidator,
    validationMiddleware,
    wrapRoute(kitController, 'updateBrief', 'kit.updateBrief'),
  );

  router.post(
    '/:kitId/regenerate',
    regenerateValidator,
    validationMiddleware,
    wrapRoute(kitController, 'regenerate', 'kit.regenerate'),
  );

  return router;
};
