import type { Request, Response } from 'express';
import { matchedData } from 'express-validator';
import type { ApiSuccessResponse } from '@/common/types/api-response.type';
import { UnauthorizedException } from '@/common/errors/http-exception';
import type { InterviewKit } from '@/modules/kit/kit.type';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_LIMIT,
  type PaginatedResult,
} from '@/common/types/pagination.type';
import type {
  AddFlashcardInput,
  AddQuestionInput,
  CreateKitResult,
  KitDetailResult,
  KitStatusResult,
  KitSummary,
  RegenerateSectionInput,
  ReorderQuestionsInput,
  UpdateBriefInput,
  UpdateFlashcardInput,
  UpdateQuestionInput,
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
    const result = await this.dependencies.kitService.createKit(
      this.requireUserId(req),
      {
        jd: String(req.body.jd),
        companyUrl: String(req.body.companyUrl),
        days: Number(req.body.days),
      },
      this.idempotencyKey(req),
    );

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

  async updateQuestion(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.updateQuestion(
      this.requireUserId(req),
      req.params.kitId as string,
      req.params.questionId as string,
      req.body as UpdateQuestionInput,
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(200).json(response);
  }

  async addQuestion(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.addQuestion(
      this.requireUserId(req),
      req.params.kitId as string,
      req.body as AddQuestionInput,
      this.idempotencyKey(req),
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(201).json(response);
  }

  async reorderQuestions(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.reorderQuestions(
      this.requireUserId(req),
      req.params.kitId as string,
      req.body as ReorderQuestionsInput,
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(200).json(response);
  }

  async deleteQuestion(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.deleteQuestion(
      this.requireUserId(req),
      req.params.kitId as string,
      req.params.questionId as string,
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(200).json(response);
  }

  async addFlashcard(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.addFlashcard(
      this.requireUserId(req),
      req.params.kitId as string,
      req.body as AddFlashcardInput,
      this.idempotencyKey(req),
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(201).json(response);
  }

  async updateFlashcard(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.updateFlashcard(
      this.requireUserId(req),
      req.params.kitId as string,
      req.params.flashcardId as string,
      req.body as UpdateFlashcardInput,
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(200).json(response);
  }

  async deleteFlashcard(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.deleteFlashcard(
      this.requireUserId(req),
      req.params.kitId as string,
      req.params.flashcardId as string,
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(200).json(response);
  }

  async updateBrief(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.updateBrief(
      this.requireUserId(req),
      req.params.kitId as string,
      req.body as UpdateBriefInput,
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(200).json(response);
  }

  async regenerate(req: Request, res: Response): Promise<void> {
    const kit = await this.dependencies.kitService.regenerate(
      this.requireUserId(req),
      req.params.kitId as string,
      req.body as RegenerateSectionInput,
      this.idempotencyKey(req),
    );

    const response: ApiSuccessResponse<InterviewKit> = { success: true, data: kit };
    res.status(200).json(response);
  }

  // Optional per-action key: the frontend sends one UUID per logical action
  // and reuses it across transport retries. Absent keys execute normally.
  private idempotencyKey(req: Request): string | undefined {
    const raw = req.header('Idempotency-Key');
    const key = typeof raw === 'string' ? raw.trim() : '';

    return key ? key : undefined;
  }

  private requireUserId(req: Request): string {
    const userId = req.session.userId;

    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return userId;
  }
}
