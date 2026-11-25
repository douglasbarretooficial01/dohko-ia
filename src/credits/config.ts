import type { Plan } from "./types.js";

/** Parâmetros de negócio — ajuste aqui, sem tocar na lógica. */
export const CONFIG = {
  /** Margem bruta alvo. preço = custo / (1 - margem). 0.65 → markup ~2,86x */
  targetGrossMargin: 0.65,
  /** Valor de referência de 1 crédito em R$ (receita esperada por crédito). */
  creditValueBRL: 0.49,
  /** Câmbio US$→R$. Em produção, atualizar diariamente. */
  usdToBrl: 5.5,
  /** Cobrança mínima por ação de build (créditos). */
  minBuildCharge: 0.1,
  /** Cobrança mínima por mensagem de chat (créditos). */
  minChatCharge: 0.01,
  /** Preço fixo do modo plan (créditos por mensagem). */
  planModePrice: 1,
  /** Folga aplicada à estimativa na hora de reservar créditos. */
  reserveBuffer: 1.5,
  /** Créditos grátis diários (renovam 00:00 America/Sao_Paulo). */
  dailyBuildCredits: 5,
  dailyChatCredits: 3,
  /** Validade dos créditos de plano (meses após emissão) e de recarga. */
  planCreditTtlMonths: 2,
  topupTtlMonths: 12,
};

/** Custo dos modelos em US$ por 1M tokens. Preencher com a tabela real dos provedores. */
export const MODEL_COST_USD_PER_MTOK: Record<string, { in: number; out: number; cachedIn?: number }> = {
  "fast-cheap": { in: 0.1, out: 0.4 },
  mid: { in: 1, out: 5, cachedIn: 0.1 },
  frontier: { in: 5, out: 25, cachedIn: 0.5 },
};

/**
 * Perfis médios por tipo de tarefa, usados para estimar e reservar antes de executar.
 * Valores iniciais chutados — recalibrar com a tabela action_usage (média e p90 por task_type).
 */
export const TASK_PROFILES: Record<string, { model: string; avgInputTokens: number; avgOutputTokens: number; avgToolCostsUSD?: number }> = {
  chat_message: { model: "fast-cheap", avgInputTokens: 4_000, avgOutputTokens: 600 },
  small_edit: { model: "mid", avgInputTokens: 25_000, avgOutputTokens: 2_000 },
  feature: { model: "frontier", avgInputTokens: 60_000, avgOutputTokens: 8_000 },
  page_with_images: { model: "frontier", avgInputTokens: 40_000, avgOutputTokens: 10_000, avgToolCostsUSD: 0.08 },
};

/** Planos em R$ (exemplos — definir com o time comercial). */
export const PLANS: Record<string, Plan> = {
  free: { id: "free", name: "Grátis", priceBRL: 0, monthlyCredits: 0, topupPriceBRL: null },
  pro_100: { id: "pro_100", name: "Pro 100", priceBRL: 49, monthlyCredits: 100, topupPriceBRL: 0.6 },
  pro_200: { id: "pro_200", name: "Pro 200", priceBRL: 98, monthlyCredits: 200, topupPriceBRL: 0.6 },
  pro_400: { id: "pro_400", name: "Pro 400", priceBRL: 196, monthlyCredits: 400, topupPriceBRL: 0.6 },
  pro_800: { id: "pro_800", name: "Pro 800", priceBRL: 392, monthlyCredits: 800, topupPriceBRL: 0.6 },
};
