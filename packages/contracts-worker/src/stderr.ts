export const WORKER_STDERR_MAX_BYTES = 65_536;
export const WORKER_STDERR_MAX_CHUNKS = 256;
export const WORKER_STDERR_TRUNCATION_MARKER = "[WORKER_STDERR_TRUNCATED]";

export interface WorkerStderrCollector {
  append(chunk: Uint8Array): void;
  lines(): readonly string[];
  readonly truncated: boolean;
}

export function createWorkerStderrCollector(
  options: {
    readonly maxBytes?: number;
    readonly maxChunks?: number;
  } = {},
): WorkerStderrCollector {
  const maxBytes = positiveSafeInteger(
    options.maxBytes ?? WORKER_STDERR_MAX_BYTES,
    "maxBytes",
  );
  const maxChunks = positiveSafeInteger(
    options.maxChunks ?? WORKER_STDERR_MAX_CHUNKS,
    "maxChunks",
  );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let chunkCount = 0;
  let wasTruncated = false;

  return {
    append(chunk) {
      chunkCount += 1;
      if (chunkCount > maxChunks || bytes >= maxBytes) {
        wasTruncated = true;
        return;
      }
      const remaining = maxBytes - bytes;
      const retained =
        chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk.slice();
      if (retained.byteLength > 0) {
        chunks.push(retained);
        bytes += retained.byteLength;
      }
      if (retained.byteLength !== chunk.byteLength) wasTruncated = true;
    },
    lines() {
      const value = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        value.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const lines = new TextDecoder().decode(value).split(/\r?\n/u).filter(Boolean);
      return wasTruncated ? [...lines, WORKER_STDERR_TRUNCATION_MARKER] : lines;
    },
    get truncated() {
      return wasTruncated;
    },
  };
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Worker stderr ${field} must be a positive safe integer.`);
  }
  return value;
}
