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
  /** Segredo para assinar a sessão de login. Gere com: openssl rand -hex 32 */
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET precisa de pelo menos 32 caracteres"),
  /** Chave do OpenRouter (https://openrouter.ai/keys). Vazia = modo simulado. */
  OPENROUTER_API_KEY: z.string().default(""),
  /** Opcional: catálogo de modelos em JSON (sobrescreve o padrão de src/llm/models.ts). */
  DOHKO_MODELS: z.string().default(""),
  /** Opcional: {"fast":"...","balanced":"...","deep":"...","build":"..."} */
  DOHKO_TIER_DEFAULT: z.string().default(""),
  JOBS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
});

export const env = schema.parse(process.env);
export const stripePrices: Record<string, string> = JSON.parse(env.STRIPE_PRICES);
