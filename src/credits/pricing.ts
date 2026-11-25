import { CONFIG, MODEL_COST_USD_PER_MTOK } from "./config.js";
import type { Mode, UsageEvent } from "./types.js";

export const MARKUP = 1 / (1 - CONFIG.targetGrossMargin);

/** Arredonda para cima em 2 casas, sem lixo de ponto flutuante. */
export const ceil2 = (n: number) => Math.ceil(Math.round(n * 1e6) / 1e4) / 100;
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Custo real da ação para a Dohko, em R$. */
export function realCostBRL(ev: UsageEvent): number {
  let usd = ev.toolCostsUSD ?? 0;
  for (const c of ev.calls) {
    const p = MODEL_COST_USD_PER_MTOK[c.model];
    if (!p) throw new Error(`MODELO_SEM_PRECO: ${c.model}`);
    const cached = Math.min(c.cachedInputTokens ?? 0, c.inputTokens);
    usd += ((c.inputTokens - cached) * p.in + cached * (p.cachedIn ?? p.in) + c.outputTokens * p.out) / 1e6;
  }
  return usd * CONFIG.usdToBrl;
}

/** Créditos cobrados por uma ação já executada. */
export function creditsFor(ev: UsageEvent): number {
  if (ev.mode === "plan") return CONFIG.planModePrice;
  const fraction = Math.max(0, Math.min(1, ev.completedFraction ?? 1));
  if (fraction === 0) return 0; // parou antes de mudar algo → grátis
  const raw = (realCostBRL(ev) * MARKUP * fraction) / CONFIG.creditValueBRL;
  const min = ev.mode === "chat" ? CONFIG.minChatCharge : CONFIG.minBuildCharge;
  return ceil2(Math.max(raw, min));
}

/**
 * Estimativa antes de executar — para mostrar ao usuário ("deve custar ~0,8 crédito")
 * e para reservar saldo. Base: média histórica de tokens por tipo de tarefa.
 */
export interface TaskProfile {
  model: string;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgToolCostsUSD?: number;
}

export function estimate(mode: Mode, profile: TaskProfile) {
  const expected = creditsFor({
    mode,
    calls: [{ model: profile.model, inputTokens: profile.avgInputTokens, outputTokens: profile.avgOutputTokens }],
    toolCostsUSD: profile.avgToolCostsUSD,
  });
  const reserve = mode === "plan" ? expected : ceil2(expected * CONFIG.reserveBuffer);
  return { expected, reserve };
}

/** Margem real de uma ação (para o painel financeiro). */
export function actionMargin(ev: UsageEvent, creditRevenueBRL = CONFIG.creditValueBRL) {
  const cost = realCostBRL(ev);
  const revenue = creditsFor(ev) * creditRevenueBRL;
  return { costBRL: cost, revenueBRL: revenue, margin: revenue > 0 ? 1 - cost / revenue : 0 };
}
