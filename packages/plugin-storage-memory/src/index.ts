import { StorageCapabilityToken } from "@prism/contracts-storage";
import { definePlugin } from "@prism/kernel";
import { MemoryStorage } from "./memory-storage.js";

export { createMemoryStorage, MemoryStorage } from "./memory-storage.js";

export const storageMemoryPlugin = definePlugin({
  id: "storage.memory",
  version: "0.1.0",
  provides: [StorageCapabilityToken],
  register(context) {
    context.provide(StorageCapabilityToken, new MemoryStorage(context.events));
  },
});
