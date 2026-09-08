import type { Request, Response } from 'express';
import { matchedData } from 'express-validator';
import type { ApiSuccessResponse } from '@/common/types/api-response.type';
import { UnauthorizedException } from '@/common/errors/http-exception';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_LIMIT,
  type PaginatedResult,
} from '@/common/types/pagination.type';
import type {
  CreateKitResult,
  KitDetailResult,
  KitStatusResult,
  KitSummary,
} from '@/modules/kit/kit-api.type';
import type { KitService } from '@/modules/kit/kit.service';

type KitControllerDependencies = {
  kitService: KitService;
};

export class KitController {
  constructor(private readonly dependencies: KitControllerDependencies) {}

  async list(req: Request, res: Response): Promise<void> {
    const query = matchedData(req) as { page?: number; limit?: number };
    const result = await this.dependencies.kitService.listKits(this.requireUserId(req), {
      page: query.page ?? DEFAULT_PAGE,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });

    const response: ApiSuccessResponse<PaginatedResult<KitSummary>> = {
      success: true,
      data: result,
    };

    res.status(200).json(response);
  }

  async create(req: Request, res: Response): Promise<void> {
    const result = await this.dependencies.kitService.createKit(this.requireUserId(req), {
      jd: String(req.body.jd),
      companyUrl: String(req.body.companyUrl),
      days: Number(req.body.days),
    });

    const response: ApiSuccessResponse<CreateKitResult> = {
      success: true,
      data: result,
    };

    res.status(201).json(response);
  }

  async getById(req: Request, res: Response): Promise<void> {
    const result = await this.dependencies.kitService.getKit(
      this.requireUserId(req),
      req.params.kitId as string,
    );

    const response: ApiSuccessResponse<KitDetailResult> = {
      success: true,
      data: result,
    };

    res.status(200).json(response);
  }

  async getStatus(req: Request, res: Response): Promise<void> {
    const result = await this.dependencies.kitService.getKitStatus(
      this.requireUserId(req),
      req.params.kitId as string,
    );

    const response: ApiSuccessResponse<KitStatusResult> = {
      success: true,
      data: result,
    };

    res.status(200).json(response);
  }

  async recordPractice(req: Request, res: Response): Promise<void> {
    const result = await this.dependencies.kitService.recordPractice(
      this.requireUserId(req),
      req.params.kitId as string,
      req.params.flashcardId as string,
      Number(req.body.confidence),
    );

    const response: ApiSuccessResponse<{ recorded: true }> = {
      success: true,
      data: result,
    };

    res.status(200).json(response);
  }

  private requireUserId(req: Request): string {
    const userId = req.session.userId;

    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return userId;
  }
}
