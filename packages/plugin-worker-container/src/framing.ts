import { deserialize, serialize } from "node:v8";

const MAX_FRAME_BYTES = 64 * 1_024 * 1_024;

export function encodeWorkerFrame(value: unknown): Uint8Array {
  const payload = serialize(value);
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Worker message exceeds the frame size limit.");
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class WorkerFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): readonly unknown[] {
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const messages: unknown[] = [];
    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.buffered = Buffer.alloc(0);
        throw new Error("Worker frame exceeds the size limit.");
      }
      if (this.buffered.byteLength < 4 + length) break;
      const payload = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      messages.push(deserialize(payload));
    }
    return messages;
  }
}
