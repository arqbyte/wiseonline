import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';

import { DrizzleHealthService } from '../db/drizzle-health.service';
import { HealthController } from './health.controller';

function createMockResponse(): { res: Response; statusMock: jest.Mock } {
  const statusMock = jest.fn();
  const res = { status: statusMock } as unknown as Response;
  statusMock.mockReturnValue(res);
  return { res, statusMock };
}

describe('HealthController', () => {
  let controller: HealthController;
  let drizzleHealthService: { ping: jest.Mock };

  beforeEach(async () => {
    drizzleHealthService = { ping: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DrizzleHealthService, useValue: drizzleHealthService },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /health', () => {
    it('returns 200 and status ok when the DB is reachable', async () => {
      drizzleHealthService.ping.mockResolvedValue({ ok: true, latencyMs: 3 });
      const { res, statusMock } = createMockResponse();

      const body = await controller.check(res);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(body.status).toBe('ok');
      expect(body.db).toEqual({ ok: true, latencyMs: 3 });
      expect(typeof body.uptime).toBe('number');
      expect(typeof body.timestamp).toBe('string');
    });

    it('returns 503 and status error, without leaking secrets/stack, when the DB is unreachable', async () => {
      const loggerErrorSpy = jest
        .spyOn(
          (controller as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      const sensitiveError = new Error(
        'connection to server at "db.internal" failed: password authentication failed for user "app_user" (postgres://app_user:s3cr3t@db.internal:5432/wiseonline)',
      );
      drizzleHealthService.ping.mockRejectedValue(sensitiveError);
      const { res, statusMock } = createMockResponse();

      const body = await controller.check(res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(body.status).toBe('error');
      expect(body.db).toEqual({ ok: false });

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('s3cr3t');
      expect(serialized).not.toContain('postgres://');
      expect(serialized).not.toContain('app_user');
      expect(serialized).not.toContain(sensitiveError.stack);

      // The full error is still logged server-side for debugging.
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'DB health check failed',
        sensitiveError.stack,
      );
    });
  });

  describe('GET /health/live', () => {
    it('always returns 200 with status ok, independent of the DB', () => {
      const body = controller.live();

      expect(body.status).toBe('ok');
      expect(typeof body.uptime).toBe('number');
      expect(typeof body.timestamp).toBe('string');
    });
  });
});
