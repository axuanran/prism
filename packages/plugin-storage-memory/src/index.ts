import {
  AtomicWriteCapabilityToken,
  StorageCapabilityToken,
} from "@prismengine/contracts-storage";
import { definePlugin } from "@prismengine/kernel";
import { MemoryStorage } from "./memory-storage.js";

export {
  createMemoryStorage,
  MemoryStorage,
} from "./memory-storage.js";

export const storageMemoryPlugin = definePlugin({
  id: "storage.memory",
  version: "0.1.18",
  provides: [StorageCapabilityToken, AtomicWriteCapabilityToken],
  register(context) {
    const storage = new MemoryStorage(context.events);
    context.provide(StorageCapabilityToken, storage);
    context.provide(AtomicWriteCapabilityToken, storage);
  },
});
