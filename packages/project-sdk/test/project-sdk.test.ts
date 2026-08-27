import { describe, expect, it } from "vitest";
import {
  defineCodeMaterial,
  defineProjectActions,
  defineProjectApp,
} from "@prismengine/project-sdk";

describe("Project SDK", () => {
  it("preserves client, action, and material module identities", async () => {
    const app = defineProjectApp({ mount: async ({ root }) => { root.textContent = "ready"; } });
    const actions = defineProjectActions({ ping: async () => ({ pong: true }) });
    const material = defineCodeMaterial<number, null, number>((input) => input * 2);
    expect(typeof app.mount).toBe("function");
    expect(await actions.ping()).toEqual({ pong: true });
    expect(await material(3, null, {} as never)).toBe(6);
  });
});
