/**
 * Runtime configuration.
 *
 * Every environment variable is read here and nowhere else, so what the process
 * depends on is legible in one file and a missing value fails at boot rather
 * than halfway through someone's task.
 */

import { z } from "zod";

const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  port: z.coerce.number().int().positive().default(4000),

  /** The single stateful dependency. */
  databaseUrl: z.string().min(1, "DATABASE_URL is required."),

  /**
   * Vault master key, base64-encoded 32 bytes. Optional at boot so the service
   * can start unconfigured and report the vault as unavailable, rather than
   * refusing to run at all.
   */
  secretEncryptionKey: z.string().optional(),

  kernelApiKey: z.string().optional(),
  modelGatewayApiKey: z.string().optional(),

  /** Commercial features stay disabled without a valid signed key. */
  licenseKey: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    secretEncryptionKey: env.SECRET_ENCRYPTION_KEY,
    kernelApiKey: env.KERNEL_API_KEY,
    modelGatewayApiKey: env.MODEL_GATEWAY_API_KEY,
    licenseKey: env.NELL_LICENSE_KEY,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

/** What the service can actually do with the configuration it was given. */
export interface Capabilities {
  readonly vault: boolean;
  readonly browser: boolean;
  readonly inference: boolean;
}

export function capabilitiesOf(config: Config): Capabilities {
  return {
    vault: Boolean(config.secretEncryptionKey),
    browser: Boolean(config.kernelApiKey),
    inference: Boolean(config.modelGatewayApiKey),
  };
}
