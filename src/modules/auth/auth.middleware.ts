import type { RequestHandler } from 'express';
import type { RequestContextService } from '@/common/context/request-context.service';
import { UnauthorizedException } from '@/common/errors/http-exception';

type RequireAuthDependencies = {
  requestContext: RequestContextService;
};

export const createRequireAuthMiddleware = ({
  requestContext,
}: RequireAuthDependencies): RequestHandler =>
  (req, _res, next): void => {
    const userId = req.session.userId;

    if (!userId) {
      next(new UnauthorizedException('Authentication required'));
      return;
    }

    requestContext.setUserId(userId);
    next();
  };
