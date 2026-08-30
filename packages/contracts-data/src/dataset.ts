import type * as arrow from "apache-arrow";
import { arrowBatchFromRows, rowValueFromArrow, toArrowSchema } from "./arrow.js";
import type { CallContext } from "./call-context.js";
import { PrismError } from "./diagnostics.js";
import type { Row, TableType } from "./value-type.js";

/**
 * The columnar batch boundary.
 *
 * Capabilities exchange Arrow record batches, never per-row objects. `Row`
 * remains only as an explicit materialization escape hatch for seeds, JSON
 * inputs, previews and the V0.1 in-memory calculation backend.
 */
export class DataBatch {
  constructor(
    readonly schema: TableType,
    readonly recordBatch: arrow.RecordBatch,
  ) {}

  get numRows(): number {
    return this.recordBatch.numRows;
  }

  getColumn(column: string | number): arrow.Vector | undefined {
    const vector =
      typeof column === "number"
        ? this.recordBatch.getChildAt(column)
        : this.recordBatch.getChild(column);
    return vector ?? undefined;
  }
}

export interface Dataset {
  /** Stable name used in pipelines, traces and fingerprints. */
  readonly name: string;
  readonly schema: TableType;
  /** Re-iterable: calling `stream` twice must yield the same immutable batches. */
  stream(context: CallContext): AsyncIterable<DataBatch>;
}

export const DEFAULT_BATCH_ROWS = 1024;

export function datasetFromRows(
  name: string,
  schema: TableType,
  rows: readonly Row[],
  batchSize: number = DEFAULT_BATCH_ROWS,
): Dataset {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw PrismError.of(
      "DATASET_BATCH_SIZE_INVALID",
      "Dataset batch size must be a positive safe integer.",
      { batchSize },
    );
  }

  const arrowSchema = toArrowSchema(schema);
  const batches: DataBatch[] = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batchRows = rows.slice(offset, offset + batchSize);
    batches.push(new DataBatch(schema, arrowBatchFromRows(schema, batchRows, arrowSchema)));
  }

  return {
    name,
    schema,
    async *stream(context: CallContext): AsyncIterable<DataBatch> {
      for (const batch of batches) {
        context.signal?.throwIfAborted();
        yield batch;
      }
    },
  };
}

/**
 * Materializes one columnar batch into row objects. This is an explicit,
 * allocation-heavy escape hatch; streaming or columnar code must use
 * `DataBatch.getColumn` instead.
 */
export function materializeBatchRows(batch: DataBatch): readonly Row[] {
  const columns = batch.schema.columns.map((field, columnIndex) => {
    const vector = batch.getColumn(columnIndex);
    if (vector === undefined) {
      throw PrismError.of(
        "DATASET_BATCH_COLUMN_MISSING",
        `Arrow batch is missing column "${field.name}".`,
        { column: field.name, columnIndex },
      );
    }
    return { field, vector };
  });

  const rows: Row[] = [];
  for (let rowIndex = 0; rowIndex < batch.numRows; rowIndex += 1) {
    const row: Record<string, Row[string]> = {};
    for (const { field, vector } of columns) {
      row[field.name] = rowValueFromArrow(vector.get(rowIndex), field, rowIndex);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Materializes an entire dataset. This is intentionally expensive and exists
 * only for row-oriented V0.1 internals and presentation boundaries.
 */
export async function collectRows(
  dataset: Dataset,
  context: CallContext,
): Promise<readonly Row[]> {
  const rows: Row[] = [];
  for await (const batch of dataset.stream(context)) {
    rows.push(...materializeBatchRows(batch));
  }
  return rows;
}

/** Counts physical batch rows without constructing a single row object. */
export async function countRows(dataset: Dataset, context: CallContext): Promise<number> {
  let total = 0;
  for await (const batch of dataset.stream(context)) total += batch.numRows;
  return total;
}
