import { randomUUID } from "node:crypto";
import { CONFIG, PLANS } from "./config.js";
import { creditsFor, round2 } from "./pricing.js";
import type { CreditRepo, CreditTx } from "./repo.js";
import type { CreditBucket, GrantKind, Hold, Mode, UsageEvent } from "./types.js";

export class InsufficientCreditsError extends Error {
  constructor(public needed: number, public available: number) {
    super(`SALDO_INSUFICIENTE: precisa ${needed}, tem ${available}`);
  }
}

/** Ordem de consumo: grants específicos do modo → créditos gerais que vencem primeiro. */
const SPECIFIC: Record<Mode, GrantKind[]> = {
  chat: ["daily_chat", "daily_build"],
  plan: ["daily_build"],
  build: ["daily_build"],
};
const GENERAL: GrantKind[] = ["plan", "bonus", "topup"];

const addMonths = (d: Date, m: number) => {
  const r = new Date(d);
  r.setMonth(r.getMonth() + m);
  return r;
};

/** Próxima meia-noite em America/Sao_Paulo (UTC-3, sem horário de verão desde 2019). */
export const nextMidnightBRT = (now: Date) => {
  const brt = new Date(now.getTime() - 3 * 3600_000);
  brt.setUTCHours(24, 0, 0, 0);
  return new Date(brt.getTime() + 3 * 3600_000);
};

export class CreditEngine {
  constructor(private repo: CreditRepo, private clock: () => Date = () => new Date()) {}

  // ---------- Concessões ----------

  /** Créditos do ciclo de cobrança (chamar no webhook de pagamento aprovado). */
  grantPlanCycle(workspaceId: string, planId: string, invoiceId: string) {
    const plan = PLANS[planId];
    if (!plan) throw new Error(`PLANO_INEXISTENTE: ${planId}`);
    return this.grant(workspaceId, "plan", plan.monthlyCredits, addMonths(this.clock(), CONFIG.planCreditTtlMonths), `invoice:${invoiceId}`);
  }

  /** Recarga avulsa paga. */
  grantTopup(workspaceId: string, credits: number, paymentId: string) {
    return this.grant(workspaceId, "topup", credits, addMonths(this.clock(), CONFIG.topupTtlMonths), `topup:${paymentId}`);
  }

  /** Créditos diários grátis — idempotente por dia (chame no 1º uso do dia ou num cron). */
  grantDaily(workspaceId: string) {
    const now = this.clock();
    const day = new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    const exp = nextMidnightBRT(now);
    return Promise.all([
      this.grant(workspaceId, "daily_build", CONFIG.dailyBuildCredits, exp, `daily_build:${workspaceId}:${day}`),
      this.grant(workspaceId, "daily_chat", CONFIG.dailyChatCredits, exp, `daily_chat:${workspaceId}:${day}`),
    ]);
  }

  grantBonus(workspaceId: string, credits: number, expiresAt: Date, reason: string) {
    return this.grant(workspaceId, "bonus", credits, expiresAt, `bonus:${reason}`);
  }

  private grant(workspaceId: string, kind: GrantKind, amount: number, expiresAt: Date, idemKey: string) {
    return this.repo.withWorkspaceLock(workspaceId, async (tx) => {
      if (await tx.seen(idemKey)) return null;
      const now = this.clock();
      const bucket: CreditBucket = { id: randomUUID(), workspaceId, kind, balance: amount, expiresAt, createdAt: now };
      await tx.insertBucket(bucket);
      await tx.appendLedger({ id: randomUUID(), workspaceId, bucketId: bucket.id, type: "grant", amount, meta: { kind, idemKey }, createdAt: now });
      await tx.markSeen(idemKey);
      return bucket;
    });
  }

  // ---------- Saldo ----------

  async balance(workspaceId: string) {
    return this.repo.withWorkspaceLock(workspaceId, async (tx) => {
      const live = await this.liveBuckets(tx, workspaceId);
      const by = (k: GrantKind[]) => round2(live.filter((b) => k.includes(b.kind)).reduce((s, b) => s + b.balance, 0));
      return {
        total: by([...GENERAL, "daily_build", "daily_chat"]),
        daily: { build: by(["daily_build"]), chat: by(["daily_chat"]) },
        general: by(GENERAL),
        nextExpiry: live.filter((b) => GENERAL.includes(b.kind)).sort((a, b) => +a.expiresAt - +b.expiresAt)[0]?.expiresAt ?? null,
      };
    });
  }

  // ---------- Fluxo de uma ação: reserve → executa → settle ----------

  /** Reserva créditos antes de executar. Lança InsufficientCreditsError se não houver saldo. */
  reserve(workspaceId: string, actionId: string, mode: Mode, amount: number) {
    return this.repo.withWorkspaceLock(workspaceId, async (tx) => {
      const existing = await tx.getHold(actionId);
      if (existing) return existing;
      const movements = await this.take(tx, workspaceId, mode, amount, actionId, "hold");
      const hold: Hold = { actionId, workspaceId, mode, movements, total: amount, createdAt: this.clock() };
      await tx.saveHold(hold);
      return hold;
    });
  }

  /**
   * Fecha a ação com o custo real: devolve a reserva e debita o valor exato.
   * Se o real passar da reserva e faltar saldo, debita o que houver e registra o resto como writeoff
   * (a ação já rodou — não dá para "desfazer"; o writeoff vira métrica de calibração da estimativa).
   */
  settle(workspaceId: string, actionId: string, ev: UsageEvent) {
    const charge = creditsFor(ev);
    return this.repo.withWorkspaceLock(workspaceId, async (tx) => {
      const idem = `settle:${actionId}`;
      if (await tx.seen(idem)) return { charged: 0, writeoff: 0, duplicate: true };
      const hold = await tx.getHold(actionId);
      if (hold) await this.giveBack(tx, hold, "release");

      const live = await this.ordered(tx, workspaceId, ev.mode);
      const available = round2(live.reduce((s, b) => s + b.balance, 0));
      const payable = Math.min(charge, available);
      if (payable > 0) await this.take(tx, workspaceId, ev.mode, payable, actionId, "debit");
      const writeoff = round2(charge - payable);
      if (writeoff > 0) {
        await tx.appendLedger({ id: randomUUID(), workspaceId, bucketId: null, type: "writeoff", amount: -writeoff, actionId, createdAt: this.clock() });
      }
      await tx.markSeen(idem);
      return { charged: round2(payable), writeoff, duplicate: false };
    });
  }

  /** Cancela a reserva (ação falhou antes de rodar). */
  release(workspaceId: string, actionId: string) {
    return this.repo.withWorkspaceLock(workspaceId, async (tx) => {
      const hold = await tx.getHold(actionId);
      if (hold) await this.giveBack(tx, hold, "release");
    });
  }

  /** Zera buckets vencidos e registra no ledger (rodar num cron diário). */
  expire(workspaceId: string) {
    return this.repo.withWorkspaceLock(workspaceId, async (tx) => {
      const now = this.clock();
      for (const b of await tx.listBuckets(workspaceId)) {
        if (b.balance > 0 && b.expiresAt <= now) {
          await tx.appendLedger({ id: randomUUID(), workspaceId, bucketId: b.id, type: "expire", amount: -b.balance, createdAt: now });
          await tx.updateBucketBalance(b.id, 0);
        }
      }
    });
  }

  // ---------- Internos ----------

  private async liveBuckets(tx: CreditTx, ws: string) {
    const now = this.clock();
    return (await tx.listBuckets(ws)).filter((b) => b.balance > 0 && b.expiresAt > now);
  }

  private async ordered(tx: CreditTx, ws: string, mode: Mode) {
    const live = await this.liveBuckets(tx, ws);
    const specific = SPECIFIC[mode].flatMap((k) => live.filter((b) => b.kind === k));
    const general = live.filter((b) => GENERAL.includes(b.kind)).sort((a, b) => +a.expiresAt - +b.expiresAt);
    return [...specific, ...general];
  }

  private async take(tx: CreditTx, ws: string, mode: Mode, amount: number, actionId: string, type: "hold" | "debit") {
    const buckets = await this.ordered(tx, ws, mode);
    const available = round2(buckets.reduce((s, b) => s + b.balance, 0));
    if (available + 1e-9 < amount) throw new InsufficientCreditsError(amount, available);
    let remaining = amount;
    const movements: { bucketId: string; amount: number }[] = [];
    for (const b of buckets) {
      if (remaining <= 1e-9) break;
      const t = round2(Math.min(b.balance, remaining));
      if (t <= 0) continue;
      await tx.updateBucketBalance(b.id, round2(b.balance - t));
      await tx.appendLedger({ id: randomUUID(), workspaceId: ws, bucketId: b.id, type, amount: -t, actionId, createdAt: this.clock() });
      movements.push({ bucketId: b.id, amount: t });
      remaining = round2(remaining - t);
    }
    return movements;
  }

  private async giveBack(tx: CreditTx, hold: Hold, type: "release") {
    for (const m of hold.movements) {
      await tx.addToBucket(m.bucketId, m.amount);
      await tx.appendLedger({ id: randomUUID(), workspaceId: hold.workspaceId, bucketId: m.bucketId, type, amount: m.amount, actionId: hold.actionId, createdAt: this.clock() });
    }
    await tx.deleteHold(hold.actionId);
  }
}
