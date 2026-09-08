import { BadRequestException, NotFoundException } from '@/common/errors/http-exception';
import type { LoggerService } from '@/infrastructure/logger/logger.service';
import type { PaginatedResult, PaginationQuery } from '@/common/types/pagination.type';
import type {
  CreateKitInput,
  CreateKitResult,
  KitDetailResult,
  KitStatusResult,
  KitSummary,
} from '@/modules/kit/kit-api.type';
import type { KitDocument } from '@/modules/kit/kit.model';
import type { KitRepository } from '@/modules/kit/kit.repository';

type KitServiceDependencies = {
  kitRepository: KitRepository;
  logger: LoggerService;
};

export class KitService {
  constructor(private readonly dependencies: KitServiceDependencies) {}

  async listKits(
    userId: string,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<KitSummary>> {
    if (!Number.isSafeInteger(pagination.page) || !Number.isSafeInteger(pagination.limit)) {
      throw new BadRequestException('Page and limit must be safe integers.');
    }
    const result = await this.dependencies.kitRepository.findByUserPaginated(userId, pagination);
    return { items: result.items.map((kit) => this.toSummary(kit)), pagination: result.pagination };
  }

  async createKit(userId: string, input: CreateKitInput): Promise<CreateKitResult> {
    const kit = await this.dependencies.kitRepository.create({
      userId,
      jd: input.jd,
      companyUrl: input.companyUrl,
      days: input.days,
    });

    this.dependencies.logger.info('kit.created', {
      userId,
      kitId: kit.id,
    });

    return { kitId: kit.id, status: kit.status };
  }

  async getKit(userId: string, kitId: string): Promise<KitDetailResult> {
    const kit = await this.requireOwnedKit(userId, kitId);
    return { id: kit.id, status: kit.status, kit: kit.kit };
  }

  async getKitStatus(userId: string, kitId: string): Promise<KitStatusResult> {
    const kit = await this.requireOwnedKit(userId, kitId);
    return {
      kitId: kit.id,
      status: kit.status,
      progress: kit.status === 'completed' ? 100 : 0,
      steps: [],
    };
  }

  async recordPractice(
    userId: string,
    kitId: string,
    flashcardId: string,
    confidence: number,
  ): Promise<{ recorded: true }> {
    const kit = await this.requireOwnedKit(userId, kitId);

    if (kit.kit !== null && !kit.kit.flashcards.some((flashcard) => flashcard.id === flashcardId)) {
      throw new NotFoundException('Flashcard not found');
    }

    await this.dependencies.kitRepository.addPracticeRecord(userId, kitId, {
      flashcardId,
      confidence,
    });

    return { recorded: true };
  }

  private async requireOwnedKit(userId: string, kitId: string): Promise<KitDocument> {
    const kit = await this.dependencies.kitRepository.findOwnedById(userId, kitId);

    if (!kit) {
      throw new NotFoundException('Kit not found');
    }

    return kit;
  }

  private toSummary(kit: KitDocument): KitSummary {
    let company = '';
    try {
      company = new URL(kit.input.companyUrl).hostname;
    } catch {
      company = '';
    }

    return {
      id: kit.id,
      company,
      role: '',
      status: kit.status,
      createdAt: kit.createdAt.toISOString(),
      updatedAt: kit.updatedAt.toISOString(),
    };
  }
}
