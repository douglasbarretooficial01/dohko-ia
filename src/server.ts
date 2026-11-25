import Stripe from "stripe";
import { buildApp } from "./app.js";
import { CONFIG } from "./credits/config.js";
import { CreditEngine } from "./credits/engine.js";
import { PostgresRepo } from "./credits/pg-repo.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { env, stripePrices } from "./env.js";
import { startJobs } from "./jobs.js";

CONFIG.usdToBrl = env.USD_TO_BRL;

const pool = createPool(env.DATABASE_URL);
await migrate(pool);

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
});

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
