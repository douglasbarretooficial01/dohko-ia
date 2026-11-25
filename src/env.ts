import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  API_KEY: z.string().min(16, "API_KEY precisa de pelo menos 16 caracteres"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  /** JSON: {"pro_100":"price_...","pro_200":"price_..."} */
  STRIPE_PRICES: z.string().default("{}"),
  USD_TO_BRL: z.coerce.number().default(5.5),
  JOBS_ENABLED: z.coerce.boolean().default(true),
});

export const env = schema.parse(process.env);
export const stripePrices: Record<string, string> = JSON.parse(env.STRIPE_PRICES);
