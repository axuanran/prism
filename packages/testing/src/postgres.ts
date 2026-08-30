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
 * When neither answers, local tests SKIP with a loud sanitized reason.
 * PRISM_REQUIRE_POSTGRES_TESTS=1 instead fails closed for release CI.
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
  if (cached !== undefined) return enforceRequiredPostgres(cached);

  const urls = candidateUrls();
  const failureTypes: string[] = [];
  for (const url of urls) {
    let client: Client | undefined;
    try {
      client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
      await client.connect();
      await client.query("select 1");
      await client.end();
      client = undefined;
      cached = { url };
      return cached;
    } catch (error) {
      failureTypes.push(postgresProbeErrorType(error));
      await client?.end().catch(() => undefined);
    }
  }

  cached = {
    reason:
      `No PostgreSQL reachable. Checked ${String(urls.length)} candidate(s); ` +
      `error types: ${[...new Set(failureTypes)].sort().join(", ") || "unknown"}.`,
  };
  return enforceRequiredPostgres(cached);
}

function enforceRequiredPostgres(probe: PostgresProbe): PostgresProbe {
  if (process.env.PRISM_REQUIRE_POSTGRES_TESTS === "1" && "reason" in probe) {
    throw new Error(
      "PostgreSQL integration tests are required, but no test database is reachable.",
    );
  }
  return probe;
}

function postgresProbeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error";
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
