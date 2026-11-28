/**
 * Confere se a tabela continua 15% abaixo da Lovable no câmbio de hoje (PTAX do Banco Central).
 * Uso: npm run check:pricing           (usa a última PTAX disponível)
 *      npm run check:pricing -- 5.80   (simula um câmbio)
 * Sai com código 1 se algum degrau deixou de ter pelo menos 15% de desconto.
 */
import { DISCOUNT, LOVABLE_ANNUAL_MONTHS, LOVABLE_PRO_USD, LOVABLE_TOPUP_USD_PER_CREDIT, PLANS, REFERENCE_RATE, REFERENCE_RATE_DATE, TOPUP_PRICE_BRL } from "../src/credits/plans.js";

async function latestPtax(): Promise<{ rate: number; date: string }> {
  for (let back = 0; back < 10; back++) {
    const d = new Date(Date.now() - back * 86400_000);
    const mmddyyyy = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
    const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${mmddyyyy}'&$format=json`;
    const r = await fetch(url);
    if (!r.ok) continue;
    const v = (await r.json()).value?.[0];
    if (v?.cotacaoVenda) return { rate: v.cotacaoVenda, date: d.toISOString().slice(0, 10) };
  }
  throw new Error("Não consegui ler a PTAX do Banco Central.");
}

const arg = Number(process.argv[2]);
const { rate, date } = arg > 0 ? { rate: arg, date: "simulado" } : await latestPtax();
const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

console.log(`Câmbio de referência da tabela: R$ ${REFERENCE_RATE} (${REFERENCE_RATE_DATE}). Câmbio usado agora: R$ ${rate} (${date}).\n`);
let fail = 0;
const check = (label: string, ours: number, lovableUSD: number) => {
  const lov = lovableUSD * rate;
  const off = 1 - ours / lov;
  const ok = off >= DISCOUNT - 1e-9;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${label.padEnd(22)} Dohko ${brl(ours).padStart(14)}  Lovable ${brl(lov).padStart(14)}  desconto ${(off * 100).toFixed(1)}%`);
};
for (const t of LOVABLE_PRO_USD) {
  check(`Pro ${t.credits} mensal`, PLANS[`pro_${t.credits}`].priceBRL, t.monthlyUSD);
  check(`Pro ${t.credits} anual`, PLANS[`pro_${t.credits}_anual`].priceBRL, t.monthlyUSD * LOVABLE_ANNUAL_MONTHS);
}
check("Recarga (por crédito)", TOPUP_PRICE_BRL, LOVABLE_TOPUP_USD_PER_CREDIT);

console.log(
  fail
    ? `\n${fail} item(ns) com menos de 15% de desconto neste câmbio. Atualize REFERENCE_RATE em src/credits/plans.ts e rode os testes.`
    : "\nTudo pelo menos 15% abaixo da Lovable neste câmbio.",
);
process.exit(fail ? 1 : 0);
