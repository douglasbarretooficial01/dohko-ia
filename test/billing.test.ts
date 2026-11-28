import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { buildApp } from "../src/app.js";
import { CreditEngine } from "../src/credits/engine.js";
import { PostgresRepo } from "../src/credits/pg-repo.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { runMaintenance } from "../src/jobs.js";
import { ModelCatalog } from "../src/llm/models.js";
import { MockProvider } from "../src/llm/provider.js";

const DB = process.env.TEST_DATABASE_URL;
const WH = "whsec_test";

describe.skipIf(!DB)("cobrança: checkout, plano anual e troca de plano", () => {
  const pool = createPool(DB!);
  const engine = new CreditEngine(new PostgresRepo(pool));
  const real = new Stripe("sk_test_x");
  const calls: { checkout: any[]; update: any[] } = { checkout: [], update: [] };
  const subs = new Map<string, any>();
  const fake = {
    webhooks: real.webhooks,
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: { sessions: { create: async (p: any) => (calls.checkout.push(p), { url: "https://checkout.stripe.com/x" }) } },
    subscriptions: {
      retrieve: async (id: string) => subs.get(id),
      update: async (id: string, p: any) => (calls.update.push({ id, ...p }), subs.get(id)),
    },
    billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.com/p" }) } },
  } as unknown as Stripe;
  const app = buildApp({ pool, engine, apiKey: "k".repeat(20), catalog: new ModelCatalog(), provider: new MockProvider(0), sessionSecret: "s".repeat(40), stripe: fake, stripeWebhookSecret: WH, appUrl: "http://localhost:3000" });
  let cookie = "";
  let wid = "";
  const call = (method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { cookie, "content-type": "application/json" }, payload: body ? JSON.stringify(body) : undefined });
  const webhook = (event: object) => {
    const payload = JSON.stringify(event);
    return app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": real.webhooks.generateTestHeaderString({ payload, secret: WH }) }, payload });
  };
  const paid = (invoiceId: string, subId: string, periodEnd?: number) =>
    webhook({ id: `evt_${invoiceId}`, object: "event", type: "invoice.paid", data: { object: { id: invoiceId, object: "invoice", parent: { subscription_details: { subscription: subId } }, lines: { data: [{ period: { end: periodEnd } }] } } } });
  const balance = async () => (await call("GET", "/api/me")).json().balance.general;

  beforeAll(async () => {
    await pool.query("drop schema public cascade; create schema public;");
    await migrate(pool, () => {});
    const r = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { name: "Dono", email: "dono@x.com", password: "senha-forte-1" } });
    cookie = String(r.headers["set-cookie"]).split(";")[0];
    wid = r.json().workspace.id;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("lista os 22 planos pagos com período", async () => {
    const plans = (await call("GET", "/api/plans")).json();
    expect(plans).toHaveLength(22);
    expect(plans.find((p: any) => p.id === "pro_100_anual")).toMatchObject({ interval: "year", priceBRL: 1176.9 });
  });

  it("checkout monta o preço em R$ na hora (sem preços cadastrados no Stripe)", async () => {
    const r = await call("POST", "/api/billing/checkout", { planId: "pro_100_anual" });
    expect(r.json().url).toContain("checkout.stripe.com");
    const li = calls.checkout[0].line_items[0];
    expect(li.price_data).toMatchObject({ currency: "brl", unit_amount: 117690, recurring: { interval: "year" } });
    expect(calls.checkout[0].subscription_data.metadata).toEqual({ workspace_id: wid, plan_id: "pro_100_anual" });
  });

  it("anual: libera o 1º mês no pagamento e um mês a cada mês, nunca duas vezes, só até o fim do ano", async () => {
    const end = Math.floor(Date.now() / 1000) + 365 * 86400;
    subs.set("sub_a", { id: "sub_a", metadata: { workspace_id: wid, plan_id: "pro_100_anual" }, items: { data: [{ id: "si_1", price: { product: "prod_1" } }] } });
    await paid("in_a1", "sub_a", end);
    expect(await balance()).toBe(100);

    await runMaintenance(pool, engine, () => {}); // ainda não venceu o mês
    expect(await balance()).toBe(100);

    // servidor ficou fora do ar: dois meses vencidos → recupera os dois
    await pool.query("update workspaces set next_plan_grant_at = now() - interval '35 days' where id = $1", [wid]);
    await runMaintenance(pool, engine, () => {});
    expect(await balance()).toBe(300);
    await runMaintenance(pool, engine, () => {});
    expect(await balance()).toBe(300); // idempotente

    // depois do fim do período pago, não libera mais
    await pool.query("update workspaces set next_plan_grant_at = now() - interval '1 day', plan_period_end = now() - interval '2 days' where id = $1", [wid]);
    await runMaintenance(pool, engine, () => {});
    expect(await balance()).toBe(300);
  });

  it("quem já assina não abre segunda assinatura; troca de plano usa a assinatura atual com proporcional", async () => {
    const dup = await call("POST", "/api/billing/checkout", { planId: "pro_200" });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toBe("JA_TEM_ASSINATURA_TROQUE_O_PLANO");

    const r = await call("POST", "/api/billing/change", { planId: "pro_400" });
    expect(r.statusCode).toBe(200);
    expect(calls.update[0]).toMatchObject({
      id: "sub_a",
      proration_behavior: "always_invoice",
      metadata: { plan_id: "pro_400" },
      items: [{ id: "si_1", price_data: { currency: "brl", unit_amount: 47090, product: "prod_1", recurring: { interval: "month" } } }],
    });

    // Stripe confirma o pagamento da troca → plano mensal, créditos do novo plano, agenda anual limpa
    subs.set("sub_a", { ...subs.get("sub_a"), metadata: { workspace_id: wid, plan_id: "pro_400" } });
    await paid("in_a2", "sub_a");
    const me = (await call("GET", "/api/me")).json();
    expect(me.workspace.planId).toBe("pro_400");
    expect(me.balance.general).toBe(700);
    const w = (await pool.query("select next_plan_grant_at from workspaces where id = $1", [wid])).rows[0];
    expect(w.next_plan_grant_at).toBeNull();
  });

  it("portal do Stripe e cancelamento", async () => {
    expect((await call("POST", "/api/billing/portal")).json().url).toContain("billing.stripe.com");
    await webhook({ id: "evt_del", object: "event", type: "customer.subscription.deleted", data: { object: { id: "sub_a", object: "subscription" } } });
    const me = (await call("GET", "/api/me")).json();
    expect(me.workspace.planId).toBe("free");
    expect(me.workspace.hasSubscription).toBe(false);
  });
});
