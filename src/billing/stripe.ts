import Stripe from "stripe";
import type pg from "pg";
import { PLANS } from "../credits/config.js";
import type { CreditEngine } from "../credits/engine.js";

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

export interface BillingDeps {
  stripe: Stripe;
  pool: pg.Pool;
  engine: CreditEngine;
  prices: Record<string, string>; // planId → Stripe price id
  appUrl: string;
}

async function ensureCustomer({ stripe, pool }: BillingDeps, workspaceId: string) {
  const r = await pool.query("select name, stripe_customer_id from workspaces where id = $1", [workspaceId]);
  if (!r.rowCount) throw bad(`WORKSPACE_NAO_ENCONTRADO: ${workspaceId}`);
  if (r.rows[0].stripe_customer_id) return r.rows[0].stripe_customer_id as string;
  const c = await stripe.customers.create({ name: r.rows[0].name, metadata: { workspace_id: workspaceId } });
  await pool.query("update workspaces set stripe_customer_id = $2 where id = $1", [workspaceId, c.id]);
  return c.id;
}

/** Checkout de assinatura de um plano. */
export async function createPlanCheckout(d: BillingDeps, workspaceId: string, planId: string) {
  const price = d.prices[planId];
  if (!PLANS[planId] || !price) throw bad(`PLANO_SEM_PRECO_STRIPE: ${planId}`);
  const customer = await ensureCustomer(d, workspaceId);
  const meta = { workspace_id: workspaceId, plan_id: planId };
  const s = await d.stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: meta },
    metadata: meta,
    success_url: `${d.appUrl}/?pagamento=sucesso`,
    cancel_url: `${d.appUrl}/?pagamento=cancelado`,
  });
  return s.url;
}

/** Checkout de recarga avulsa (preço em R$ por crédito, conforme o plano atual). */
export async function createTopupCheckout(d: BillingDeps, workspaceId: string, credits: number) {
  const r = await d.pool.query("select plan_id from workspaces where id = $1", [workspaceId]);
  const plan = PLANS[r.rows[0]?.plan_id];
  if (!plan?.topupPriceBRL) throw bad("PLANO_SEM_RECARGA");
  if (!Number.isInteger(credits) || credits < 50 || credits > 1000) throw bad("RECARGA_ENTRE_50_E_1000");
  const customer = await ensureCustomer(d, workspaceId);
  const s = await d.stripe.checkout.sessions.create({
    mode: "payment",
    customer,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: Math.round(credits * plan.topupPriceBRL * 100),
          product_data: { name: `Recarga Dohko — ${credits} créditos` },
        },
      },
    ],
    metadata: { workspace_id: workspaceId, kind: "topup", credits: String(credits) },
    success_url: `${d.appUrl}/?pagamento=sucesso`,
    cancel_url: `${d.appUrl}/?pagamento=cancelado`,
  });
  return s.url;
}

function subscriptionIdOf(invoice: Stripe.Invoice): string | null {
  const parent = (invoice as any).parent?.subscription_details?.subscription;
  const legacy = (invoice as any).subscription;
  const v = parent ?? legacy;
  return typeof v === "string" ? v : v?.id ?? null;
}

/** Trata um evento do Stripe já verificado. Idempotente (o motor deduplica por invoice/pagamento). */
export async function handleStripeEvent(d: BillingDeps, event: Stripe.Event) {
  switch (event.type) {
    // Assinatura paga (1ª cobrança e renovações) → créditos do ciclo
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = subscriptionIdOf(invoice);
      if (!subId) return { ignored: "invoice_sem_assinatura" };
      const sub = await d.stripe.subscriptions.retrieve(subId);
      const { workspace_id, plan_id } = sub.metadata;
      if (!workspace_id || !plan_id) return { ignored: "assinatura_sem_metadata" };
      await d.pool.query("update workspaces set plan_id = $2, stripe_subscription_id = $3 where id = $1", [workspace_id, plan_id, subId]);
      await d.engine.grantPlanCycle(workspace_id, plan_id, invoice.id!);
      return { granted: "plan", workspace_id, plan_id };
    }
    // Recarga avulsa paga
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.metadata?.kind !== "topup" || s.payment_status !== "paid") return { ignored: "checkout_nao_topup" };
      const credits = Number(s.metadata.credits);
      await d.engine.grantTopup(s.metadata.workspace_id, credits, s.id);
      return { granted: "topup", workspace_id: s.metadata.workspace_id, credits };
    }
    // Assinatura cancelada → volta ao grátis (créditos já concedidos seguem até vencer)
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await d.pool.query("update workspaces set plan_id = 'free', stripe_subscription_id = null where stripe_subscription_id = $1", [sub.id]);
      return { downgraded: sub.id };
    }
    default:
      return { ignored: event.type };
  }
}
