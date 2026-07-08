import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';

import { DrizzleHealthService } from '../db/drizzle-health.service';

interface HealthResponse {
  status: 'ok' | 'error';
  db: { ok: boolean; latencyMs?: number };
  uptime: number;
  timestamp: string;
  message?: string;
}

/**
 * `/health` slice of card 1.1: reports DB connectivity via the Drizzle
 * app_user client. `/health` is a readiness check (includes DB round-trip);
 * `/health/live` is a liveness check (process up, no DB dependency).
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly drizzleHealthService: DrizzleHealthService) {}

  @Get()
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponse> {
    const timestamp = new Date().toISOString();
    const uptime = process.uptime();

    try {
      const db = await this.drizzleHealthService.ping();
      res.status(HttpStatus.OK);
      return { status: 'ok', db, uptime, timestamp };
    } catch (error) {
      // Log the full error (may include connection details / stack trace)
      // server-side only. Never forward `error` itself to the client.
      this.logger.error(
        'DB health check failed',
        error instanceof Error ? error.stack : error,
      );
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'error',
        db: { ok: false },
        uptime,
        timestamp,
        message: 'Database connectivity check failed',
      };
    }
  }

  @Get('live')
  live(): { status: 'ok'; uptime: number; timestamp: string } {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
