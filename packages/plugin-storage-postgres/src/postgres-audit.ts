import { createHash, randomUUID } from "node:crypto";
import type { CallContext } from "@prismengine/contracts-data";
import type {
  AuditJournal,
  AuditQuery,
  AuditRecord,
  AuditVerification,
} from "@prismengine/contracts-storage";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { PostgresDatabase } from "./database.js";

type DatabaseExecutor = Kysely<PostgresDatabase> | Transaction<PostgresDatabase>;

export interface PostgresAuditChange {
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly before: unknown;
  readonly after: unknown;
}

export class PostgresAuditJournal implements AuditJournal {
  constructor(
    private readonly db: Kysely<PostgresDatabase>,
    private readonly schema: string,
  ) {}

  async append(
    executor: DatabaseExecutor,
    context: CallContext,
    change: PostgresAuditChange,
  ): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtext(${`${this.schema}.audit_journal`}))`.execute(
      executor,
    );
    const sequenceResult = await sql<{ readonly sequence: string }>`
      select nextval(pg_get_serial_sequence(${`${this.schema}.audit_journal`}, 'sequence'))::text
        as sequence
    `.execute(executor);
    const sequenceText = sequenceResult.rows[0]?.sequence;
    if (sequenceText === undefined) throw new Error("Audit sequence allocation failed.");
    const previous = await executor
      .withSchema(this.schema)
      .selectFrom("audit_journal")
      .select(["entry_hash"])
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    const timestamp = new Date();
    const unsigned = {
      sequence: Number(sequenceText),
      id: randomUUID(),
      timestamp: timestamp.toISOString(),
      principalId: context.principal.id,
      action: change.action,
      targetKind: change.targetKind,
      targetId: change.targetId,
      beforeFingerprint: change.before === null ? null : fingerprint(change.before),
      afterFingerprint: change.after === null ? null : fingerprint(change.after),
      ...(context.changeReason ? { reason: context.changeReason } : {}),
      correlationId: context.correlationId,
      ...(context.approvalId ? { approvalId: context.approvalId } : {}),
      previousHash: previous?.entry_hash ?? null,
    };
    await executor
      .withSchema(this.schema)
      .insertInto("audit_journal")
      .values({
        sequence: sequenceText,
        id: unsigned.id,
        recorded_at: timestamp,
        principal_id: unsigned.principalId,
        action: unsigned.action,
        target_kind: unsigned.targetKind,
        target_id: unsigned.targetId,
        before_fingerprint: unsigned.beforeFingerprint,
        after_fingerprint: unsigned.afterFingerprint,
        reason: unsigned.reason ?? null,
        correlation_id: unsigned.correlationId,
        approval_id: unsigned.approvalId ?? null,
        previous_hash: unsigned.previousHash,
        entry_hash: fingerprint(unsigned),
      })
      .execute();
  }

  async list(
    _context: CallContext,
    query: AuditQuery = {},
  ): Promise<readonly AuditRecord[]> {
    const limit = Math.max(0, Math.min(query.limit ?? 100, 1_000));
    let statement = this.db
      .withSchema(this.schema)
      .selectFrom("audit_journal")
      .selectAll()
      .where("sequence", ">", String(query.afterSequence ?? 0))
      .orderBy("sequence", "asc")
      .limit(limit);
    if (query.targetKind !== undefined) {
      statement = statement.where("target_kind", "=", query.targetKind);
    }
    if (query.targetId !== undefined) {
      statement = statement.where("target_id", "=", query.targetId);
    }
    return (await statement.execute()).map(mapAuditRecord);
  }

  async verify(context: CallContext): Promise<AuditVerification> {
    let previousHash: string | null = null;
    let afterSequence = 0;
    let checked = 0;
    while (true) {
      const records = await this.list(context, { afterSequence, limit: 1_000 });
      if (records.length === 0) return { valid: true, checked };
      for (const record of records) {
        const { entryHash, ...unsigned } = record;
        if (record.previousHash !== previousHash || fingerprint(unsigned) !== entryHash) {
          return {
            valid: false,
            checked,
            brokenAtSequence: record.sequence,
          };
        }
        previousHash = entryHash;
        afterSequence = record.sequence;
        checked += 1;
      }
    }
  }
}

function mapAuditRecord(row: {
  readonly sequence: string;
  readonly id: string;
  readonly recorded_at: Date;
  readonly principal_id: string;
  readonly action: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly before_fingerprint: string | null;
  readonly after_fingerprint: string | null;
  readonly reason: string | null;
  readonly correlation_id: string;
  readonly approval_id: string | null;
  readonly previous_hash: string | null;
  readonly entry_hash: string;
}): AuditRecord {
  return Object.freeze({
    sequence: Number(row.sequence),
    id: row.id,
    timestamp: row.recorded_at.toISOString(),
    principalId: row.principal_id,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    beforeFingerprint: row.before_fingerprint,
    afterFingerprint: row.after_fingerprint,
    ...(row.reason === null ? {} : { reason: row.reason }),
    correlationId: row.correlation_id,
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    previousHash: row.previous_hash,
    entryHash: row.entry_hash,
  });
}

function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
