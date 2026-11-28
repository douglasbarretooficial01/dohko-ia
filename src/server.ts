import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { buildApp } from "./app.js";
import { CONFIG } from "./credits/config.js";
import { CreditEngine } from "./credits/engine.js";
import { PostgresRepo } from "./credits/pg-repo.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { env, stripePrices } from "./env.js";
import { startJobs } from "./jobs.js";
import { DEFAULT_MODELS, ModelCatalog, TIER_DEFAULT } from "./llm/models.js";
import { MockProvider, OpenRouterProvider } from "./llm/provider.js";
import { ResendMailer } from "./mail.js";

CONFIG.usdToBrl = env.USD_TO_BRL;

const pool = createPool(env.DATABASE_URL);
await migrate(pool);

const catalog = new ModelCatalog(
  env.DOHKO_MODELS ? JSON.parse(env.DOHKO_MODELS) : DEFAULT_MODELS,
  env.DOHKO_TIER_DEFAULT ? { ...TIER_DEFAULT, ...JSON.parse(env.DOHKO_TIER_DEFAULT) } : TIER_DEFAULT,
);
const provider = env.OPENROUTER_API_KEY ? new OpenRouterProvider(env.OPENROUTER_API_KEY, env.APP_URL) : new MockProvider();

const engine = new CreditEngine(new PostgresRepo(pool));
const app = buildApp({
  pool,
  engine,
  apiKey: env.API_KEY,
  stripe: env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : undefined,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  stripePrices,
  appUrl: env.APP_URL,
  logger: true,
  catalog,
  provider,
  sessionSecret: env.SESSION_SECRET,
  secureCookies: env.APP_URL.startsWith("https://"),
  adminEmails: env.ADMIN_EMAILS.split(","),
  mailer: env.RESEND_API_KEY ? new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM) : undefined,
  webDir: join(dirname(fileURLToPath(import.meta.url)), "../web/dist"),
});

app.log.info(`provedor de IA: ${provider.name}${provider.name === "mock" ? " (modo simulado — defina OPENROUTER_API_KEY)" : ""}`);

const timer = env.JOBS_ENABLED ? startJobs(pool, engine) : undefined;

const shutdown = async () => {
  if (timer) clearInterval(timer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
