import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const sourceUrl = required("PRISM_BACKUP_SOURCE_URL");
const targetUrl = required("PRISM_BACKUP_RESTORE_TARGET_URL");
const evidencePath = resolve(required("PRISM_RESTORE_EVIDENCE_PATH"));
const source = connection(sourceUrl);
const target = connection(targetUrl);
if (
  source.database === target.database &&
  source.host === target.host &&
  source.port === target.port
) {
  throw new Error("Restore verification source and target databases must differ.");
}
if (!/^prism_restore_verify_[a-z0-9_]+$/u.test(target.database)) {
  throw new Error("Restore target database must start with prism_restore_verify_.");
}
if (process.env.PRISM_RESTORE_VERIFY_ALLOW_DESTRUCTIVE !== target.database) {
  throw new Error(
    "PRISM_RESTORE_VERIFY_ALLOW_DESTRUCTIVE must exactly equal the disposable target database name.",
  );
}

const directory = await mkdtemp(join(tmpdir(), "prism-restore-verify-"));
const archive = join(directory, "prism.dump");
const sourceData = join(directory, "source-data.sql");
const targetData = join(directory, "target-data.sql");
try {
  await command(
    "pg_dump",
    ["--format=custom", "--schema=prism", "--no-owner", "--no-acl", `--file=${archive}`],
    source.environment,
  );
  await command(
    "pg_restore",
    [
      "--clean",
      "--if-exists",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      `--dbname=${target.database}`,
      archive,
    ],
    target.environment,
  );
  await Promise.all([
    command(
      "pg_dump",
      [
        "--format=plain",
        "--schema=prism",
        "--data-only",
        "--column-inserts",
        "--rows-per-insert=1",
        `--file=${sourceData}`,
      ],
      source.environment,
    ),
    command(
      "pg_dump",
      [
        "--format=plain",
        "--schema=prism",
        "--data-only",
        "--column-inserts",
        "--rows-per-insert=1",
        `--file=${targetData}`,
      ],
      target.environment,
    ),
  ]);
  const [sourceHash, targetHash] = await Promise.all([
    fileHash(sourceData),
    fileHash(targetData),
  ]);
  if (sourceHash !== targetHash) {
    throw new Error("Restored prism schema data does not match the source logical dump.");
  }
  const auditMismatchCount = Number(
    await scalar(
      target.environment,
      `
    with chain as (
      select sequence, previous_hash,
             lag(entry_hash) over (order by sequence) as expected_previous
      from prism.audit_journal
    )
    select count(*)
    from chain
    where previous_hash is distinct from expected_previous;
  `,
    ),
  );
  if (auditMismatchCount !== 0) {
    throw new Error(`Restored audit hash chain has ${auditMismatchCount} broken links.`);
  }
  const [serverVersion, auditCount, migrationCount] = await Promise.all([
    scalar(target.environment, "show server_version;"),
    scalar(target.environment, "select count(*) from prism.audit_journal;"),
    scalar(target.environment, "select count(*) from prism.prism_migration;"),
  ]);
  const details = {
    sourceDatabase: source.database,
    targetDatabase: target.database,
    serverVersion,
    logicalDataSha256: sourceHash,
    auditRecords: Number(auditCount),
    migrations: Number(migrationCount),
    auditBrokenLinks: auditMismatchCount,
    tool: "prism-verify-postgres-restore/1.0.0",
  };
  const evidence = {
    id: "backup-restore.verified",
    passed: true,
    verifiedAt: new Date().toISOString(),
    evidence: JSON.stringify(details),
    ...details,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`Restore verification PASS; evidence=${basename(evidencePath)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function connection(value) {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("PostgreSQL connection URL is invalid.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database) throw new Error("PostgreSQL database name is required.");
  const sslmode = url.searchParams.get("sslmode");
  return {
    host: url.hostname,
    port: url.port || "5432",
    database,
    environment: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGDATABASE: database,
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      ...(sslmode ? { PGSSLMODE: sslmode } : {}),
    },
  };
}

async function command(program, args, environment) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(program, args, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      if (errorOutput.length < 16_384) errorOutput += chunk.toString("utf8");
    });
    child.once("error", rejectCommand);
    child.once("exit", (code) => {
      if (code === 0) resolveCommand();
      else
        rejectCommand(
          new Error(`${program} failed with exit ${code}: ${errorOutput.trim()}`),
        );
    });
  });
}

async function scalar(environment, query) {
  return new Promise((resolveScalar, rejectScalar) => {
    const child = spawn(
      "psql",
      ["--no-psqlrc", "--tuples-only", "--no-align", "--command", query],
      {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      if (output.length < 16_384) output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (errorOutput.length < 16_384) errorOutput += chunk.toString("utf8");
    });
    child.once("error", rejectScalar);
    child.once("exit", (code) => {
      if (code === 0) resolveScalar(output.trim());
      else rejectScalar(new Error(`psql failed with exit ${code}: ${errorOutput.trim()}`));
    });
  });
}

async function fileHash(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
