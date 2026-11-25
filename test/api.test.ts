import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { buildApp } from "../src/app.js";
import { CreditEngine } from "../src/credits/engine.js";
import { PostgresRepo } from "../src/credits/pg-repo.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { runMaintenance } from "../src/jobs.js";

const DB = process.env.TEST_DATABASE_URL;
const KEY = "test-key-1234567890";
const WH_SECRET = "whsec_test_secret";

describe.skipIf(!DB)("API + Postgres", () => {
  const pool = createPool(DB!);
  const engine = new CreditEngine(new PostgresRepo(pool));
  const realStripe = new Stripe("sk_test_dummy");
  // Stripe falso: só o necessário para o webhook (verificação de assinatura é a real)
  const fakeStripe = {
    webhooks: realStripe.webhooks,
    subscriptions: { retrieve: async (id: string) => ({ id, metadata: { workspace_id: "ws_api", plan_id: "pro_100" } }) },
  } as unknown as Stripe;
  const app = buildApp({ pool, engine, apiKey: KEY, stripe: fakeStripe, stripeWebhookSecret: WH_SECRET });
  const h = { "x-api-key": KEY, "content-type": "application/json" };
  const post = (url: string, body: unknown) => app.inject({ method: "POST", url, headers: h, payload: JSON.stringify(body) });
  const balance = async (id = "ws_api") => (await app.inject({ method: "GET", url: `/workspaces/${id}/balance`, headers: h })).json();

  const webhook = (event: object) => {
    const payload = JSON.stringify(event);
    const sig = realStripe.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET });
    return app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": sig }, payload });
  };

  beforeAll(async () => {
    await pool.query("drop schema public cascade; create schema public;");
    await migrate(pool, () => {});
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("health é público; o resto exige chave", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/plans" })).statusCode).toBe(401);
  });

  it("cria workspace com créditos diários", async () => {
    const r = await post("/workspaces", { id: "ws_api", name: "Empresa Teste" });
    expect(r.statusCode).toBe(201);
    const b = await balance();
    expect(b.planId).toBe("free");
    expect(b.daily).toEqual({ build: 5, chat: 3 });
  });

  it("webhook invoice.paid com assinatura válida concede o plano (e só uma vez)", async () => {
    const event = {
      id: "evt_1",
      object: "event",
      type: "invoice.paid",
      data: { object: { id: "in_1", object: "invoice", parent: { subscription_details: { subscription: "sub_1" } } } },
    };
    expect((await webhook(event)).statusCode).toBe(200);
    expect((await webhook(event)).statusCode).toBe(200); // Stripe reenvia — não pode duplicar
    const b = await balance();
    expect(b.planId).toBe("pro_100");
    expect(b.general).toBe(100);
  });

  it("webhook com assinatura inválida é recusado", async () => {
    const r = await app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=x" }, payload: "{}" });
    expect(r.statusCode).toBe(400);
  });

  it("fluxo completo: estimate → reserve → settle", async () => {
    const est = (await post("/actions/estimate", { mode: "build", taskType: "small_edit" })).json();
    expect(est.reserve).toBeGreaterThan(est.expected);

    const res = await post("/actions/reserve", { workspaceId: "ws_api", actionId: "act_1", mode: "build", taskType: "small_edit" });
    expect(res.statusCode).toBe(200);
    expect(res.json().reserved).toBe(est.reserve);

    const s = await post("/actions/settle", {
      workspaceId: "ws_api",
      actionId: "act_1",
      mode: "build",
      taskType: "small_edit",
      calls: [{ model: "mid", inputTokens: 20_000, outputTokens: 1_500 }],
    });
    expect(s.statusCode).toBe(200);
    const charged = s.json().charged;
    expect(charged).toBeGreaterThan(0);

    const b = await balance();
    // diário de build pagou primeiro
    expect(b.daily.build).toBeCloseTo(5 - charged, 2);
    expect(b.general).toBe(100);

    const usage = await pool.query("select * from action_usage where action_id = 'act_1'");
    expect(usage.rows[0].credits).toBe(charged);
  });

  it("settle repetido não cobra de novo", async () => {
    const before = await balance();
    const r = await post("/actions/settle", { workspaceId: "ws_api", actionId: "act_1", mode: "build", calls: [{ model: "mid", inputTokens: 20_000, outputTokens: 1_500 }] });
    expect(r.json().duplicate).toBe(true);
    expect((await balance()).total).toBe(before.total);
  });

  it("sem saldo → 402 e nada é debitado", async () => {
    await post("/workspaces", { id: "ws_pobre", name: "Sem saldo" });
    const r = await post("/actions/reserve", { workspaceId: "ws_pobre", actionId: "act_x", mode: "build", amount: 50 });
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe("SALDO_INSUFICIENTE");
    expect((await balance("ws_pobre")).daily.build).toBe(5);
  });

  it("release devolve a reserva, inclusive de bucket zerado", async () => {
    const before = await balance();
    const usable = Math.round((before.total - before.daily.chat) * 100) / 100; // build não usa cota de chat
    const r = await post("/actions/reserve", { workspaceId: "ws_api", actionId: "act_2", mode: "build", amount: usable });
    expect(r.statusCode).toBe(200);
    expect((await balance()).total).toBe(before.daily.chat);
    await post("/actions/release", { workspaceId: "ws_api", actionId: "act_2" });
    expect((await balance()).total).toBe(before.total);
  });

  it("débitos concorrentes no Postgres não estouram o saldo", async () => {
    await post("/workspaces", { id: "ws_conc", name: "Concorrência" }); // 5 build diários
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post("/actions/reserve", { workspaceId: "ws_conc", actionId: `c${i}`, mode: "build", amount: 2 })),
    );
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(2);
    expect(rs.filter((r) => r.statusCode === 402)).toHaveLength(4);
    expect((await balance("ws_conc")).daily.build).toBe(1);
  });

  it("workspace inexistente → 404", async () => {
    const r = await post("/actions/reserve", { workspaceId: "nao_existe", actionId: "a", mode: "build", amount: 1 });
    expect(r.statusCode).toBe(404);
  });

  it("manutenção libera reservas órfãs", async () => {
    const before = await balance();
    await post("/actions/reserve", { workspaceId: "ws_api", actionId: "orfa", mode: "build", amount: 3 });
    await pool.query("update credit_holds set created_at = now() - interval '2 hours' where action_id = 'orfa'");
    await runMaintenance(pool, engine, () => {});
    expect((await balance()).total).toBe(before.total);
  });

  it("ledger fecha com os buckets", async () => {
    const r = await pool.query(`
      select b.workspace_id, sum(b.balance) as buckets,
        (select coalesce(sum(amount),0) from credit_ledger l where l.workspace_id = b.workspace_id and type <> 'writeoff') as ledger
      from credit_buckets b group by b.workspace_id`);
    for (const row of r.rows) expect(row.buckets).toBeCloseTo(Number(row.ledger), 2);
  });
});
