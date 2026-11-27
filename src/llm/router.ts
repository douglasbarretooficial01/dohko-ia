import type { Tier } from "./models.js";

/**
 * Dohko One — roteador automático.
 * Escolhe o nível do modelo pelo tipo de pedido, para pagar só o necessário:
 * pergunta simples → modelo rápido; análise, código ou texto longo → modelo forte.
 * Heurística barata e explicável. Evolução: classificar com um modelo pequeno e
 * calibrar pelo feedback (👍/👎) e pela taxa de re-pergunta.
 */
const DEEP = [
  /```/,
  /\b(c[oó]digo|fun[cç][aã]o|bug|erro|stack ?trace|sql|regex|api|typescript|python|javascript)\b/i,
  /\b(analis|an[aá]lise|estrat[eé]gi|plano de neg[oó]cio|business plan|modelo financeiro|valuation|fluxo de caixa)/i,
  /\b(contrato|cl[aá]usula|jur[ií]dic|parecer|peti[cç][aã]o|lgpd)/i,
  /\b(compar[ae]|pr[oó]s e contras|trade-?off|avalie|revise|critique)/i,
  /\b(passo a passo detalhado|relat[oó]rio|artigo|ensaio|roteiro completo)/i,
];

const FAST = [
  /^(oi|ol[aá]|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|ok|beleza)\b/i,
  /\b(traduz|tradu[cç][aã]o|corrij[ae] (a )?ortografia|resum[ae] em uma frase|sin[oô]nimo)\b/i,
];

export interface RouteDecision {
  tier: Tier;
  reason: string;
}

export function routeTier(text: string, historyChars = 0): RouteDecision {
  const t = text.trim();
  if (DEEP.some((r) => r.test(t))) return { tier: "deep", reason: "pedido complexo (análise, código ou documento)" };
  if (t.length > 1200 || historyChars > 24_000) return { tier: "deep", reason: "contexto longo" };
  if (FAST.some((r) => r.test(t)) || (t.length < 100 && historyChars < 4_000)) return { tier: "fast", reason: "pergunta curta e direta" };
  return { tier: "balanced", reason: "pedido de complexidade média" };
}
