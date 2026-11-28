/**
 * Confere o catálogo de modelos contra a lista pública do OpenRouter:
 * modelo inexistente (quebraria as chamadas), preço divergente (estimativa errada)
 * e falta de suporte a imagem. Uso: npm run check:models
 * Sai com código 1 se algum modelo do catálogo não existir mais.
 */
import "dotenv/config";
import { DEFAULT_MODELS, type ModelInfo } from "../src/llm/models.js";

const models: ModelInfo[] = process.env.DOHKO_MODELS ? JSON.parse(process.env.DOHKO_MODELS) : DEFAULT_MODELS;
const res = await fetch("https://openrouter.ai/api/v1/models");
if (!res.ok) {
  console.error(`Não consegui ler a lista do OpenRouter (HTTP ${res.status}).`);
  process.exit(2);
}
const list = (await res.json()).data as any[];
const byId = new Map(list.map((m) => [m.id, m]));

let missing = 0;
for (const m of models) {
  const o = byId.get(m.providerModel);
  if (!o) {
    missing++;
    console.log(`✗ ${m.id} → ${m.providerModel}: NÃO EXISTE MAIS no OpenRouter`);
    continue;
  }
  const pin = Number(o.pricing.prompt) * 1e6;
  const pout = Number(o.pricing.completion) * 1e6;
  const notes: string[] = [];
  if (Math.abs(pin - m.price.in) > 0.001 || Math.abs(pout - m.price.out) > 0.001) {
    notes.push(`preço mudou: catálogo ${m.price.in}/${m.price.out}, OpenRouter ${+pin.toFixed(3)}/${+pout.toFixed(3)} US$ por 1M tokens`);
  }
  if (!o.architecture?.input_modalities?.includes("image")) notes.push("não lê imagens");
  console.log(`${notes.length ? "!" : "✓"} ${m.id} → ${m.providerModel}${notes.length ? `: ${notes.join("; ")}` : ""}`);
}

for (const vendor of ["anthropic/", "openai/", "google/"]) {
  const newest = list
    .filter((m) => m.id.startsWith(vendor) && !m.id.includes(":"))
    .sort((a, b) => b.created - a.created)
    .slice(0, 3)
    .map((m) => m.id);
  console.log(`  mais novos de ${vendor.slice(0, -1)}: ${newest.join(", ")}`);
}
process.exit(missing ? 1 : 0);
