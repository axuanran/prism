import { Client } from "pg";

/**
 * Resolves a REAL PostgreSQL for integration tests.
 *
 * There is deliberately no in-memory or mocked fallback. A persistence test
 * that passes against a fake proves nothing about persistence, and the bugs
 * this suite exists to catch - JSON boundary violations, constraint gaps,
 * cross-process state - are precisely the ones a fake cannot express.
 *
 * Resolution order:
 *   1. PRISM_TEST_DATABASE_URL   CI service container, or any local instance
 *   2. localhost:55432           the conventional local dev instance
 *
 * When neither answers, tests SKIP with a loud reason. They never pass quietly.
 */

export const DEFAULT_TEST_PORT = 55432;

export interface PostgresTarget {
  readonly url: string;
  readonly reason?: never;
}

export interface PostgresUnavailable {
  readonly url?: never;
  readonly reason: string;
}

export type PostgresProbe = PostgresTarget | PostgresUnavailable;

function candidateUrls(): readonly string[] {
  const configured = process.env.PRISM_TEST_DATABASE_URL;
  if (configured !== undefined && configured.trim() !== "") return [configured];
  return [`postgres://prism@127.0.0.1:${DEFAULT_TEST_PORT}/postgres`];
}

let cached: PostgresProbe | undefined;

/** Probes once per process; the answer cannot change mid-run. */
export async function probePostgres(): Promise<PostgresProbe> {
  if (cached !== undefined) return cached;

  const failures: string[] = [];
  for (const url of candidateUrls()) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      cached = { url };
      return cached;
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      await client.end().catch(() => undefined);
    }
  }

  cached = {
    reason:
      `No PostgreSQL reachable. Set PRISM_TEST_DATABASE_URL, or run one on port ${DEFAULT_TEST_PORT}. ` +
      `Tried -> ${failures.join(" | ")}`,
  };
  return cached;
}

/** Creates a uniquely named database and returns its URL plus a dropper. */
export async function createScratchDatabase(
  baseUrl: string,
  label: string,
): Promise<{ readonly url: string; drop(): Promise<void> }> {
  const name = `prism_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  await admin.end();

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;

  return {
    url: url.toString(),
    async drop(): Promise<void> {
      const cleanup = new Client({ connectionString: baseUrl });
      await cleanup.connect();
      await cleanup.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`,
        [name],
      );
      await cleanup.query(`drop database if exists "${name}"`);
      await cleanup.end();
    },
  };
}
