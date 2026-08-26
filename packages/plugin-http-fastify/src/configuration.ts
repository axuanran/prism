import { Type, type Static } from "@sinclair/typebox";
import type { ConfigurationContract, EngineInspection } from "@prism/kernel";

export const HttpConfigurationSchema = Type.Object(
  {
    port: Type.Integer({ minimum: 0, maximum: 65_535, default: 3000 }),
    host: Type.String({ minLength: 1, default: "127.0.0.1" }),
  },
  { additionalProperties: false },
);

export type HttpServerConfiguration = Static<typeof HttpConfigurationSchema>;

export const HttpConfigurationContract: ConfigurationContract<HttpServerConfiguration> = {
  schema: HttpConfigurationSchema,
  defaults: {
    port: 3000,
    host: "127.0.0.1",
  },
};

export type HttpPluginOptions = Partial<HttpServerConfiguration> & {
  readonly inspection: () => EngineInspection;
};
