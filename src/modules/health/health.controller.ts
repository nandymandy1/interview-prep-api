import type { Request, Response } from 'express';

export class HealthController {
  getHealth(_req: Request, res: Response): void {
    res.status(200).json({
      success: true,
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    });
  }
}
