import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DRIZZLE } from './drizzle.constants';
import type { DrizzleDb } from './drizzle.provider';

export interface DbPingResult {
  ok: boolean;
  latencyMs: number;
}

/** Hard cap on the health-check round-trip so a TCP-alive but wedged DB
 * (failover, connection storm, disk stall) resolves to a fast failure
 * instead of hanging the request/probe (security-engineer H1). */
const PING_TIMEOUT_MS = 2_000;

/**
 * Thin, injectable wrapper around a `SELECT 1` DB round-trip through the
 * app_user Drizzle client, for the `/health` endpoint to report DB
 * connectivity.
 */
@Injectable()
export class DrizzleHealthService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async ping(): Promise<DbPingResult> {
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`DB ping exceeded ${PING_TIMEOUT_MS}ms`)),
        PING_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.db.execute(sql`SELECT 1`), timeout]);
      return { ok: true, latencyMs: Date.now() - start };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
