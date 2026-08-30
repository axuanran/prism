import {
  WORKER_STDERR_TRUNCATION_MARKER,
  createWorkerStderrCollector,
} from "@prismengine/contracts-worker";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();

describe("Worker stderr collector", () => {
  it("retains only the byte budget and appends one truncation marker", () => {
    const collector = createWorkerStderrCollector({ maxBytes: 5, maxChunks: 10 });
    collector.append(encoder.encode("abc"));
    collector.append(encoder.encode("def-private-tail"));
    collector.append(encoder.encode("ignored"));

    expect(collector.truncated).toBe(true);
    expect(collector.lines()).toEqual(["abcde", WORKER_STDERR_TRUNCATION_MARKER]);
    expect(JSON.stringify(collector.lines())).not.toContain("private-tail");
  });

  it("continues draining while enforcing the chunk budget", () => {
    const collector = createWorkerStderrCollector({ maxBytes: 100, maxChunks: 2 });
    collector.append(encoder.encode("first\n"));
    collector.append(encoder.encode("second\n"));
    collector.append(encoder.encode("private-third\n"));

    expect(collector.lines()).toEqual(["first", "second", WORKER_STDERR_TRUNCATION_MARKER]);
  });
});
