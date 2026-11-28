import { describe, expect, it } from "vitest";
import { CreditEngine, InMemoryRepo, InsufficientCreditsError, creditsFor, estimate, actionMargin, nextMidnightBRT } from "../src/credits/index.js";

const WS = "ws_1";
const mk = (now = new Date("2026-11-25T12:00:00Z")) => {
  const repo = new InMemoryRepo();
  let t = now;
  const engine = new CreditEngine(repo, () => t);
  return { repo, engine, setNow: (d: Date) => (t = d) };
};

describe("pricing", () => {
  it("plan mode tem preço fixo", () => {
    expect(creditsFor({ mode: "plan", calls: [{ model: "frontier", inputTokens: 1e6, outputTokens: 1e6 }] })).toBe(1);
  });

  it("build cobra pelo custo real com markup e arredonda pra cima em 2 casas", () => {
    // frontier: 20k in, 4k out → (20k*5 + 4k*25)/1e6 = US$0,20 → R$1,10 → ×2,857 → R$3,14 → /1,17 (crédito de referência) = 2,69 créditos
    const c = creditsFor({ mode: "build", calls: [{ model: "frontier", inputTokens: 20_000, outputTokens: 4_000 }] });
    expect(c).toBeCloseTo(2.69, 2);
  });

  it("ação parada antes de mudar algo é grátis; parcial paga proporcional", () => {
    const calls = [{ model: "mid", inputTokens: 50_000, outputTokens: 5_000 }];
    expect(creditsFor({ mode: "build", calls, completedFraction: 0 })).toBe(0);
    const full = creditsFor({ mode: "build", calls });
    const half = creditsFor({ mode: "build", calls, completedFraction: 0.5 });
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(full / 2 - 0.02);
  });

  it("aplica cobrança mínima", () => {
    expect(creditsFor({ mode: "build", calls: [{ model: "fast-cheap", inputTokens: 100, outputTokens: 10 }] })).toBe(0.1);
    expect(creditsFor({ mode: "chat", calls: [{ model: "fast-cheap", inputTokens: 100, outputTokens: 10 }] })).toBe(0.01);
  });

  it("cache de input barateia", () => {
    const base = { model: "frontier", inputTokens: 100_000, outputTokens: 1_000 };
    expect(creditsFor({ mode: "build", calls: [{ ...base, cachedInputTokens: 90_000 }] })).toBeLessThan(
      creditsFor({ mode: "build", calls: [base] }),
    );
  });

  it("margem bate a meta de 65% (antes do arredondamento)", () => {
    const m = actionMargin({ mode: "build", calls: [{ model: "mid", inputTokens: 200_000, outputTokens: 20_000 }] });
    expect(m.margin).toBeGreaterThanOrEqual(0.649);
  });

  it("estimate reserva com folga", () => {
    const e = estimate("build", { model: "mid", avgInputTokens: 30_000, avgOutputTokens: 3_000 });
    expect(e.reserve).toBeGreaterThan(e.expected);
  });

  it("modelo sem preço quebra alto", () => {
    expect(() => creditsFor({ mode: "build", calls: [{ model: "x", inputTokens: 1, outputTokens: 1 }] })).toThrow(/MODELO_SEM_PRECO/);
  });
});

describe("engine", () => {
  it("concede plano de forma idempotente (webhook repetido)", async () => {
    const { engine } = mk();
    await engine.grantPlanCycle(WS, "pro_100", "inv_1");
    await engine.grantPlanCycle(WS, "pro_100", "inv_1");
    expect((await engine.balance(WS)).general).toBe(100);
  });

  it("consome diário antes do plano; chat usa daily_chat primeiro", async () => {
    const { engine } = mk();
    await engine.grantPlanCycle(WS, "pro_100", "inv_1");
    await engine.grantDaily(WS);
    await engine.reserve(WS, "a1", "chat", 4); // 3 daily_chat + 1 daily_build
    let b = await engine.balance(WS);
    expect(b.daily.chat).toBe(0);
    expect(b.daily.build).toBe(4);
    expect(b.general).toBe(100);
    await engine.reserve(WS, "a2", "build", 6); // 4 daily_build + 2 plan
    b = await engine.balance(WS);
    expect(b.daily.build).toBe(0);
    expect(b.general).toBe(98);
  });

  it("créditos gerais: gasta primeiro os que vencem antes", async () => {
    const { engine, repo } = mk();
    await engine.grantTopup(WS, 50, "pay_1"); // vence em 12 meses
    await engine.grantPlanCycle(WS, "pro_100", "inv_1"); // vence em 2 meses
    await engine.reserve(WS, "a1", "build", 10);
    const plan = [...repo.buckets.values()].find((b) => b.kind === "plan")!;
    const topup = [...repo.buckets.values()].find((b) => b.kind === "topup")!;
    expect(plan.balance).toBe(90);
    expect(topup.balance).toBe(50);
  });

  it("reserve → settle cobra o valor real e devolve o excesso", async () => {
    const { engine } = mk();
    await engine.grantPlanCycle(WS, "pro_100", "inv_1");
    await engine.reserve(WS, "a1", "build", 10);
    expect((await engine.balance(WS)).general).toBe(90);
    const ev = { mode: "build" as const, calls: [{ model: "mid", inputTokens: 50_000, outputTokens: 5_000 }] };
    const r = await engine.settle(WS, "a1", ev);
    expect(r.charged).toBe(creditsFor(ev));
    expect((await engine.balance(WS)).general).toBeCloseTo(100 - creditsFor(ev), 2);
  });

  it("settle é idempotente", async () => {
    const { engine } = mk();
    await engine.grantPlanCycle(WS, "pro_100", "inv_1");
    const ev = { mode: "plan" as const, calls: [] };
    await engine.settle(WS, "a1", ev);
    const r2 = await engine.settle(WS, "a1", ev);
    expect(r2.duplicate).toBe(true);
    expect((await engine.balance(WS)).general).toBe(99);
  });

  it("bloqueia ação sem saldo", async () => {
    const { engine } = mk();
    await engine.grantTopup(WS, 2, "pay_1");
    await expect(engine.reserve(WS, "a1", "build", 5)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect((await engine.balance(WS)).general).toBe(2); // nada debitado
  });

  it("custo real acima do saldo vira writeoff, nunca saldo negativo", async () => {
    const { engine, repo } = mk();
    await engine.grantTopup(WS, 1, "pay_1");
    await engine.reserve(WS, "a1", "build", 1);
    const r = await engine.settle(WS, "a1", { mode: "build", calls: [{ model: "frontier", inputTokens: 100_000, outputTokens: 20_000 }] });
    expect(r.charged).toBe(1);
    expect(r.writeoff).toBeGreaterThan(0);
    expect((await engine.balance(WS)).total).toBe(0);
    expect(repo.ledger.some((e) => e.type === "writeoff")).toBe(true);
  });

  it("release devolve tudo", async () => {
    const { engine } = mk();
    await engine.grantPlanCycle(WS, "pro_100", "inv_1");
    await engine.reserve(WS, "a1", "build", 30);
    await engine.release(WS, "a1");
    expect((await engine.balance(WS)).general).toBe(100);
  });

  it("diários vencem à meia-noite de Brasília e não acumulam", async () => {
    const { engine, setNow } = mk(new Date("2026-11-25T12:00:00Z"));
    await engine.grantDaily(WS);
    await engine.grantDaily(WS); // mesmo dia → ignorado
    expect((await engine.balance(WS)).daily.build).toBe(5);
    setNow(new Date("2026-11-26T03:00:01Z")); // 00:00:01 BRT
    expect((await engine.balance(WS)).daily.build).toBe(0);
    await engine.grantDaily(WS);
    expect((await engine.balance(WS)).daily.build).toBe(5);
  });

  it("expire zera buckets vencidos e registra no ledger", async () => {
    const { engine, repo, setNow } = mk();
    await engine.grantPlanCycle(WS, "pro_100", "inv_1");
    setNow(new Date("2027-02-26T12:00:00Z"));
    await engine.expire(WS);
    expect(repo.ledger.filter((e) => e.type === "expire")[0].amount).toBe(-100);
  });

  it("ledger fecha com o saldo (auditoria)", async () => {
    const { engine, repo } = mk();
    await engine.grantPlanCycle(WS, "pro_100", "inv_1");
    await engine.grantDaily(WS);
    await engine.reserve(WS, "a1", "build", 8);
    await engine.settle(WS, "a1", { mode: "build", calls: [{ model: "mid", inputTokens: 40_000, outputTokens: 4_000 }] });
    await engine.settle(WS, "a2", { mode: "chat", calls: [{ model: "fast-cheap", inputTokens: 5_000, outputTokens: 800 }] });
    const ledgerSum = repo.ledger.filter((e) => e.type !== "writeoff").reduce((s, e) => s + e.amount, 0);
    const bucketSum = [...repo.buckets.values()].reduce((s, b) => s + b.balance, 0);
    expect(ledgerSum).toBeCloseTo(bucketSum, 6);
  });

  it("débitos concorrentes não estouram o saldo", async () => {
    const { engine } = mk();
    await engine.grantTopup(WS, 10, "pay_1");
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => engine.reserve(WS, `a${i}`, "build", 3)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((await engine.balance(WS)).general).toBe(1);
  });

  it("nextMidnightBRT", () => {
    expect(nextMidnightBRT(new Date("2026-11-25T12:00:00Z")).toISOString()).toBe("2026-11-26T03:00:00.000Z");
    expect(nextMidnightBRT(new Date("2026-11-26T02:59:00Z")).toISOString()).toBe("2026-11-26T03:00:00.000Z");
  });
});
