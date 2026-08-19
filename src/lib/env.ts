import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  KEY_ENCRYPTION_KEY: z.string().min(1, "KEY_ENCRYPTION_KEY is required"),
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  HORIZON_URL: z
    .string()
    .url()
    .default("https://horizon-testnet.stellar.org"),
  SOROBAN_RPC_URL: z
    .string()
    .url()
    .default("https://soroban-testnet.stellar.org"),
  TAK_CONTRACT_ID: z.string().default(""),
  TAK_ISSUER_PUBLIC_KEY: z.string().min(1, "TAK_ISSUER_PUBLIC_KEY is required"),
  CRON_SECRET: z.string().default(""),
  WEBHOOK_SECRET_TOKEN: z.string().default(""),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  SEP10_SIGNING_KEY: z.string().min(1, "SEP10_SIGNING_KEY is required"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: z.string().min(1, "NEXT_PUBLIC_TELEGRAM_BOT_USERNAME is required"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const env = parsed.data;

export type Env = typeof env;
