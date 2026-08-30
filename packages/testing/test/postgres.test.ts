import { afterEach, describe, expect, it } from "vitest";
import { probePostgres } from "../src/postgres.js";

const originalUrl = process.env.PRISM_TEST_DATABASE_URL;
const originalRequired = process.env.PRISM_REQUIRE_POSTGRES_TESTS;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.PRISM_TEST_DATABASE_URL;
  else process.env.PRISM_TEST_DATABASE_URL = originalUrl;
  if (originalRequired === undefined) delete process.env.PRISM_REQUIRE_POSTGRES_TESTS;
  else process.env.PRISM_REQUIRE_POSTGRES_TESTS = originalRequired;
});

describe("PostgreSQL test probe", () => {
  it("sanitizes optional failure and fails cached unavailability when required", async () => {
    process.env.PRISM_TEST_DATABASE_URL =
      "postgres://private-user:private-password@127.0.0.1:1/private-database";
    delete process.env.PRISM_REQUIRE_POSTGRES_TESTS;

    const optional = await probePostgres();
    expect(optional).toMatchObject({
      reason: expect.stringMatching(
        /^No PostgreSQL reachable\. Checked 1 candidate\(s\); error types: [A-Za-z0-9, ]+\.$/u,
      ),
    });
    expect(JSON.stringify(optional)).not.toMatch(
      /private-user|private-password|private-database|postgres:\/\//u,
    );

    process.env.PRISM_REQUIRE_POSTGRES_TESTS = "1";
    await expect(probePostgres()).rejects.toThrow(
      "PostgreSQL integration tests are required, but no test database is reachable.",
    );
  });
});
