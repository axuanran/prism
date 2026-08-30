import { randomUUID } from "node:crypto";
import { systemCallContext } from "@prismengine/contracts-data";
import type { AuditExportCapability } from "@prismengine/contracts-storage";
import type { Logger } from "@prismengine/kernel";

export function startAuditExportLoop(
  exporter: AuditExportCapability,
  intervalMs: number,
  logger: Logger,
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  let cursor = 0;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = drain().finally(schedule);
    }, intervalMs);
    timer.unref?.();
  };
  const drain = async (): Promise<void> => {
    try {
      while (!stopped) {
        const context = systemCallContext({
          correlationId: `audit-export-${randomUUID()}`,
        });
        const result = await exporter.exportRange(context, cursor, 1_000);
        cursor = result.lastSequence;
        if (result.verified < 1_000) return;
      }
    } catch (error) {
      logger.error("Durable audit export failed.", {
        errorType: error instanceof Error ? error.name : typeof error,
        afterSequence: cursor,
      });
    }
  };

  running = drain().finally(schedule);
  return {
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      await running;
      const context = systemCallContext({
        correlationId: `audit-export-final-${randomUUID()}`,
      });
      let verified = 1_000;
      while (verified === 1_000) {
        const result = await exporter.exportRange(context, cursor, 1_000);
        cursor = result.lastSequence;
        verified = result.verified;
      }
    },
  };
}
