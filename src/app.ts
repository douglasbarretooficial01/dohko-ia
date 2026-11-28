import Fastify, { type FastifyError } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type Stripe from "stripe";
import { z, ZodError } from "zod";
import { PLANS, TASK_PROFILES } from "./credits/config.js";
import { CreditEngine, InsufficientCreditsError } from "./credits/engine.js";
import { WorkspaceNotFoundError } from "./credits/pg-repo.js";
import { creditsFor, estimate, realCostBRL } from "./credits/pricing.js";
import { createPlanCheckout, createTopupCheckout, handleStripeEvent, type BillingDeps } from "./billing/stripe.js";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import type { ModelCatalog } from "./llm/models.js";
import type { LLMProvider } from "./llm/provider.js";
import { userRoutes } from "./routes/user.js";
import type { Mailer } from "./mail.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface AppDeps {
  pool: pg.Pool;
  engine: CreditEngine;
  apiKey: string;
  stripe?: Stripe;
  stripeWebhookSecret?: string;
  stripePrices?: Record<string, string>;
  appUrl?: string;
  logger?: boolean;
  catalog: ModelCatalog;
  provider: LLMProvider;
  sessionSecret: string;
  secureCookies?: boolean;
  /** Pasta do front compilado (web/dist). Se existir, é servida em "/". */
  webDir?: string;
  adminEmails?: string[];
  mailer?: Mailer;
}

/** Rotas internas (agentes/serviços da Dohko) — exigem x-api-key. */
const INTERNAL = ["/workspaces", "/actions", "/plans", "/billing/"];

const Mode = z.enum(["chat", "plan", "build"]);
const Call = z.object({
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});
const Profile = z.object({
  model: z.string(),
  avgInputTokens: z.number().int().nonnegative(),
  avgOutputTokens: z.number().int().nonnegative(),
  avgToolCostsUSD: z.number().nonnegative().optional(),
});

function profileFor(taskType?: string, profile?: z.infer<typeof Profile>) {
  if (profile) return profile;
  const p = taskType ? TASK_PROFILES[taskType] : undefined;
  if (!p) throw Object.assign(new Error("TIPO_DE_TAREFA_DESCONHECIDO: envie taskType conhecido ou profile"), { statusCode: 400 });
  return p;
}

export function buildApp(d: AppDeps) {
  const app = Fastify({ logger: d.logger ?? false });

  // Guarda o corpo bruto (assinatura do webhook do Stripe precisa dele)
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  app.register(cookie);

  // Autenticação por chave nas rotas internas. As rotas /api usam sessão (cookie).
  const key = Buffer.from(d.apiKey);
  app.addHook("onRequest", async (req, reply) => {
    if (!INTERNAL.some((p) => req.url.startsWith(p))) return;
    const got = Buffer.from(String(req.headers["x-api-key"] ?? ""));
    if (got.length !== key.length || !timingSafeEqual(got, key)) return reply.code(401).send({ error: "NAO_AUTORIZADO" });
  });

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "ENTRADA_INVALIDA", details: err.issues });
    if (err instanceof InsufficientCreditsError)
      return reply.code(402).send({ error: "SALDO_INSUFICIENTE", needed: err.needed, available: err.available });
    if (err instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: "WORKSPACE_NAO_ENCONTRADO" });
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status === 500 ? "ERRO_INTERNO" : err.message });
  });

  app.get("/health", async () => {
    await d.pool.query("select 1");
    return { ok: true };
  });

  // ---------- Workspaces ----------

  app.post("/workspaces", async (req, reply) => {
    const b = z.object({ id: z.string().min(1).optional(), name: z.string().min(1) }).parse(req.body);
    const id = b.id ?? `ws_${randomUUID()}`;
    await d.pool.query("insert into workspaces (id, name) values ($1, $2)", [id, b.name]);
    await d.engine.grantDaily(id);
    return reply.code(201).send({ id, name: b.name, planId: "free" });
  });

  app.get("/workspaces/:id/balance", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await d.engine.grantDaily(id); // concede o diário no 1º acesso do dia (idempotente)
    const r = await d.pool.query("select plan_id from workspaces where id = $1", [id]);
    return { planId: r.rows[0]?.plan_id, ...(await d.engine.balance(id)) };
  });

  app.get("/workspaces/:id/ledger", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
    const r = await d.pool.query(
      `select id, bucket_id, type, amount, action_id, meta, created_at from credit_ledger
       where workspace_id = $1 order by created_at desc limit $2`,
      [id, limit],
    );
    return r.rows;
  });

  app.get("/plans", async () => Object.values(PLANS));

  // ---------- Ações: estimate → reserve → (agente roda) → settle | release ----------

  app.post("/actions/estimate", async (req) => {
    const b = z.object({ mode: Mode, taskType: z.string().optional(), profile: Profile.optional() }).parse(req.body);
    return estimate(b.mode, profileFor(b.taskType, b.profile));
  });

  app.post("/actions/reserve", async (req) => {
    const b = z
      .object({
        workspaceId: z.string(),
        actionId: z.string().min(1),
        mode: Mode,
        amount: z.number().positive().optional(),
        taskType: z.string().optional(),
        profile: Profile.optional(),
      })
      .parse(req.body);
    await d.engine.grantDaily(b.workspaceId);
    const amount = b.amount ?? estimate(b.mode, profileFor(b.taskType, b.profile)).reserve;
    const hold = await d.engine.reserve(b.workspaceId, b.actionId, b.mode, amount);
    return { actionId: hold.actionId, reserved: hold.total };
  });

  app.post("/actions/settle", async (req) => {
    const b = z
      .object({
        workspaceId: z.string(),
        actionId: z.string().min(1),
        mode: Mode,
        taskType: z.string().optional(),
        calls: z.array(Call),
        toolCostsUSD: z.number().nonnegative().optional(),
        completedFraction: z.number().min(0).max(1).optional(),
      })
      .parse(req.body);
    const ev = { mode: b.mode, calls: b.calls, toolCostsUSD: b.toolCostsUSD, completedFraction: b.completedFraction };
    const res = await d.engine.settle(b.workspaceId, b.actionId, ev);
    if (!res.duplicate) {
      const tokens = b.calls.reduce(
        (s, c) => ({ i: s.i + c.inputTokens, o: s.o + c.outputTokens, c: s.c + (c.cachedInputTokens ?? 0) }),
        { i: 0, o: 0, c: 0 },
      );
      await d.pool.query(
        `insert into action_usage (action_id, workspace_id, mode, task_type, input_tokens, output_tokens, cached_tokens,
           tool_cost_usd, real_cost_brl, credits, writeoff)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (action_id) do nothing`,
        [b.actionId, b.workspaceId, b.mode, b.taskType ?? null, tokens.i, tokens.o, tokens.c, b.toolCostsUSD ?? 0, realCostBRL(ev), creditsFor(ev), res.writeoff],
      );
    }
    return res;
  });

  app.post("/actions/release", async (req) => {
    const b = z.object({ workspaceId: z.string(), actionId: z.string() }).parse(req.body);
    await d.engine.release(b.workspaceId, b.actionId);
    return { released: true };
  });

  // ---------- Cobrança (Stripe) ----------

  const billing = (): BillingDeps => {
    if (!d.stripe) throw Object.assign(new Error("STRIPE_NAO_CONFIGURADO"), { statusCode: 503 });
    return { stripe: d.stripe, pool: d.pool, engine: d.engine, prices: d.stripePrices ?? {}, appUrl: d.appUrl ?? "" };
  };

  // ---------- App do usuário (/api) ----------

  app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    await userRoutes(scope, {
      pool: d.pool,
      engine: d.engine,
      catalog: d.catalog,
      provider: d.provider,
      sessionSecret: d.sessionSecret,
      secureCookies: d.secureCookies ?? false,
      billing,
      adminEmails: d.adminEmails,
      mailer: d.mailer,
      appUrl: d.appUrl,
    });
  });

  // ---------- Apps publicados (públicos) ----------
  // Servidos com CSP "sandbox": o app roda numa origem isolada, sem acesso à sessão
  // nem às rotas /api de quem estiver logado na Dohko.

  app.get("/p/:slug", async (req, reply) => {
    const { slug } = z.object({ slug: z.string().max(80) }).parse(req.params);
    const r = await d.pool.query("select published_html from conversations where published_slug = $1", [slug]);
    reply
      .header("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .type("text/html; charset=utf-8");
    if (!r.rowCount || !r.rows[0].published_html) {
      return reply
        .code(404)
        .send(`<!DOCTYPE html><meta charset="utf-8"><title>App não encontrado</title><body style="font-family:system-ui;background:#0b0d12;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>App não encontrado</h1><p>Este link não existe ou foi despublicado.</p><a style="color:#f5b301" href="/">Criar o seu com a Dohko IA</a></div>`);
    }
    return reply.header("cache-control", "public, max-age=60").send(r.rows[0].published_html);
  });

  // ---------- Front (SPA) ----------

  if (d.webDir && existsSync(d.webDir)) {
    app.register(fastifyStatic, { root: d.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !INTERNAL.some((p) => req.url.startsWith(p))) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "NAO_ENCONTRADO" });
    });
  }

  app.post("/billing/checkout", async (req) => {
    const b = z.object({ workspaceId: z.string(), planId: z.string() }).parse(req.body);
    return { url: await createPlanCheckout(billing(), b.workspaceId, b.planId) };
  });

  app.post("/billing/topup", async (req) => {
    const b = z.object({ workspaceId: z.string(), credits: z.number().int() }).parse(req.body);
    return { url: await createTopupCheckout(billing(), b.workspaceId, b.credits) };
  });

  app.post("/webhooks/stripe", async (req, reply) => {
    const deps = billing();
    const sig = req.headers["stripe-signature"];
    let event: Stripe.Event;
    try {
      event = deps.stripe.webhooks.constructEvent(req.rawBody ?? Buffer.alloc(0), String(sig ?? ""), d.stripeWebhookSecret ?? "");
    } catch {
      return reply.code(400).send({ error: "ASSINATURA_INVALIDA" });
    }
    const result = await handleStripeEvent(deps, event);
    req.log.info({ type: event.type, result }, "stripe webhook");
    return { received: true, result };
  });

  return app;
}
