import type { Plan } from "./types.js";

/**
 * Tabela de preços da Dohko IA: 15% abaixo da Lovable em cada degrau, convertida pelo câmbio de referência.
 *
 *   preço Dohko (R$) = preço Lovable (US$) × (1 − 15%) × câmbio, arredondado PARA BAIXO até o ",90" mais próximo
 *
 * O arredondamento para baixo garante que o desconto real é sempre ≥ 15%.
 * Se o dólar subir, a diferença cresce; se cair muito, rode `npm run check:pricing` (avisa quando
 * algum degrau deixa de estar 15% abaixo) e atualize REFERENCE_RATE. Mudar a tabela não altera
 * assinaturas antigas no Stripe; vale para novas compras.
 */

/** Tabela pública da Lovable (plano Pro, mensal, US$), conferida em 28/11/2026 em docs.lovable.dev/introduction/messaging-limits. */
export const LOVABLE_PRO_USD: { credits: number; monthlyUSD: number }[] = [
  { credits: 100, monthlyUSD: 25 },
  { credits: 200, monthlyUSD: 50 },
  { credits: 400, monthlyUSD: 100 },
  { credits: 800, monthlyUSD: 200 },
  { credits: 1_200, monthlyUSD: 294 },
  { credits: 2_000, monthlyUSD: 480 },
  { credits: 3_000, monthlyUSD: 705 },
  { credits: 4_000, monthlyUSD: 920 },
  { credits: 5_000, monthlyUSD: 1_125 },
  { credits: 7_500, monthlyUSD: 1_688 },
  { credits: 10_000, monthlyUSD: 2_250 },
];
/** A Lovable cobra no anual 10× o mensal (2 meses grátis). */
export const LOVABLE_ANNUAL_MONTHS = 10;
/** Recarga avulsa da Lovable no Pro: US$ 15 por 50 créditos. */
export const LOVABLE_TOPUP_USD_PER_CREDIT = 15 / 50;

export const DISCOUNT = 0.15;
/** Câmbio de referência: PTAX de venda do Banco Central em 27/11/2026. */
export const REFERENCE_RATE = 5.543;
export const REFERENCE_RATE_DATE = "2026-11-27";

/** Maior valor terminado em ",90" que não passa de `brl` (ex.: 117,79 → 116,90; 117,95 → 117,90). */
export const floorTo90 = (brl: number) => Math.floor(Math.round((brl + 0.1) * 100) / 100) - 0.1;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function dohkoPrice(usd: number, rate = REFERENCE_RATE) {
  return round2(floorTo90(usd * (1 - DISCOUNT) * rate));
}

export const fmtCredits = (n: number) => n.toLocaleString("pt-BR");

/** Preço por crédito avulso (centavos para baixo). */
export const TOPUP_PRICE_BRL = Math.floor(LOVABLE_TOPUP_USD_PER_CREDIT * (1 - DISCOUNT) * REFERENCE_RATE * 100) / 100;

function buildPlans(): Record<string, Plan> {
  const plans: Record<string, Plan> = {
    free: { id: "free", name: "Grátis", priceBRL: 0, monthlyCredits: 0, topupPriceBRL: null, interval: "month", tierCredits: 0 },
  };
  for (const t of LOVABLE_PRO_USD) {
    const monthly = dohkoPrice(t.monthlyUSD);
    plans[`pro_${t.credits}`] = {
      id: `pro_${t.credits}`,
      name: `Pro ${fmtCredits(t.credits)}`,
      priceBRL: monthly,
      monthlyCredits: t.credits,
      topupPriceBRL: TOPUP_PRICE_BRL,
      interval: "month",
      tierCredits: t.credits,
      referenceUSD: t.monthlyUSD,
    };
    const annualUSD = t.monthlyUSD * LOVABLE_ANNUAL_MONTHS;
    plans[`pro_${t.credits}_anual`] = {
      id: `pro_${t.credits}_anual`,
      name: `Pro ${fmtCredits(t.credits)} anual`,
      priceBRL: dohkoPrice(annualUSD), // cobrado uma vez por ano
      monthlyCredits: t.credits, // liberados todo mês durante o ano
      topupPriceBRL: TOPUP_PRICE_BRL,
      interval: "year",
      tierCredits: t.credits,
      referenceUSD: annualUSD,
    };
  }
  return plans;
}

export const PLANS: Record<string, Plan> = buildPlans();

/**
 * Valor de referência de 1 crédito: preço por crédito do plano de entrada (Pro 100 mensal).
 * É a base de conversão custo → créditos no motor (margem alvo em CONFIG).
 */
export const CREDIT_VALUE_BRL = round2(PLANS.pro_100.priceBRL / PLANS.pro_100.monthlyCredits);
