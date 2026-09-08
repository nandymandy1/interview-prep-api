import type { Request, Response } from 'express';
import type { ApiSuccessResponse } from '../../common/types/api-response.type';
import type { AuthResult } from './auth.type';
import type { AuthService } from './auth.service';
import { UnauthorizedException } from '../../common/errors/http-exception';

type AuthControllerDependencies = {
  authService: AuthService;
};

export class AuthController {
  constructor(private readonly dependencies: AuthControllerDependencies) {}

  async register(req: Request, res: Response): Promise<void> {
    const result = await this.dependencies.authService.register({
      email: String(req.body.email),
      password: String(req.body.password),
    });

    req.session.userId = result.user.id;

    const response: ApiSuccessResponse<AuthResult> = {
      success: true,
      data: result,
    };

    res.status(201).json(response);
  }

  async login(req: Request, res: Response): Promise<void> {
    const result = await this.dependencies.authService.login({
      email: String(req.body.email),
      password: String(req.body.password),
    });

    req.session.userId = result.user.id;

    const response: ApiSuccessResponse<AuthResult> = {
      success: true,
      data: result,
    };

    res.status(200).json(response);
  }

  async logout(req: Request, res: Response): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    res.clearCookie(req.app.get('sessionCookieName'));
    res.status(200).json({
      success: true,
      data: { loggedOut: true },
    });
  }

  async me(req: Request, res: Response): Promise<void> {
    if (!req.session.userId) {
      throw new UnauthorizedException();
    }

    const user = await this.dependencies.authService.getCurrentUser(req.session.userId);

    res.status(200).json({
      success: true,
      data: { user },
    });
  }
}
