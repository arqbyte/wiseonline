/** Injection token for the pooled `pg.Pool` (app_user connection). */
export const PG_POOL = Symbol('PG_POOL');

/** Injection token for the Drizzle query client (app_user connection). */
export const DRIZZLE = Symbol('DRIZZLE');
