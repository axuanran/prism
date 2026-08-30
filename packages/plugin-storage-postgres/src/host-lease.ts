import { PrismError } from "@prismengine/contracts-data";
import { Pool, type PoolClient } from "pg";

export interface PostgresHostLease {
  release(): Promise<void>;
}

export async function acquirePostgresHostLease(options: {
  readonly connectionString: string;
  readonly deploymentId: string;
  readonly schema?: string;
}): Promise<PostgresHostLease> {
  const schema = options.schema ?? "prism";
  const pool = new Pool({ connectionString: options.connectionString, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const lockKey = JSON.stringify([schema, options.deploymentId, "production-host"]);
    const result = await client.query<{ readonly acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
      [lockKey],
    );
    if (result.rows[0]?.acquired !== true) {
      throw PrismError.of(
        "HOST_SINGLE_WRITER_UNAVAILABLE",
        "Another Production Host already owns the deployment lease.",
        { deploymentId: options.deploymentId, schema },
      );
    }
    let released = false;
    return {
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try {
          await client?.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
            lockKey,
          ]);
        } finally {
          client?.release();
          await pool.end();
        }
      },
    };
  } catch (error) {
    client?.release();
    await pool.end();
    if (error instanceof PrismError) throw error;
    throw PrismError.of(
      "HOST_LEASE_FAILED",
      "Production Host could not acquire its PostgreSQL deployment lease.",
      { deploymentId: options.deploymentId, schema },
    );
  }
}
