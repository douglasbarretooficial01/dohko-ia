import { MODEL_COST_USD_PER_MTOK } from "../credits/config.js";

export type Tier = "fast" | "balanced" | "deep";

export interface ModelInfo {
  /** ID interno da Dohko (vai para o banco e para o front). */
  id: string;
  label: string;
  vendor: string;
  description: string;
  tier: Tier;
  /** ID do modelo no OpenRouter. */
  providerModel: string;
  /** Preço em US$ por 1M tokens (para estimar antes de rodar; o custo real vem do provedor). */
  price: { in: number; out: number };
}

/**
 * Catálogo padrão. Os IDs do OpenRouter mudam com frequência: confira em https://openrouter.ai/models
 * e sobrescreva sem mexer no código com a variável DOHKO_MODELS (JSON com a mesma estrutura).
 */
export const DEFAULT_MODELS: ModelInfo[] = [
  // IDs e preços conferidos na lista oficial do OpenRouter em 28/11/2026 (npm run check:models confere de novo).
  {
    id: "claude-haiku",
    label: "Claude Haiku",
    vendor: "Anthropic",
    description: "Rápido e barato para perguntas do dia a dia",
    tier: "fast",
    providerModel: "anthropic/claude-haiku-5.5",
    price: { in: 0.1, out: 0.5 },
  },
  {
    id: "gpt-luna",
    label: "GPT Luna",
    vendor: "OpenAI",
    description: "Respostas rápidas e econômicas",
    tier: "fast",
    providerModel: "openai/gpt-6-luna",
    price: { in: 0.1, out: 0.5 },
  },
  {
    id: "gpt-terra",
    label: "GPT Terra",
    vendor: "OpenAI",
    description: "Equilíbrio entre qualidade e custo; ótimo com imagens",
    tier: "balanced",
    providerModel: "openai/gpt-6.1-terra",
    price: { in: 1, out: 5 },
  },
  {
    id: "gemini-flash",
    label: "Gemini Flash",
    vendor: "Google",
    description: "Rápido, com contexto longo para documentos grandes",
    tier: "balanced",
    providerModel: "google/gemini-3.8-flash",
    price: { in: 0.825, out: 4.125 },
  },
  {
    id: "claude-sonnet",
    label: "Claude Sonnet",
    vendor: "Anthropic",
    description: "Excelente em escrita, análise e construção de apps",
    tier: "deep",
    providerModel: "anthropic/claude-sonnet-5.5",
    price: { in: 2, out: 10 },
  },
  {
    id: "gpt-sol",
    label: "GPT Sol",
    vendor: "OpenAI",
    description: "Raciocínio forte para tarefas complexas",
    tier: "deep",
    providerModel: "openai/gpt-6.2-sol",
    price: { in: 2, out: 10 },
  },
  {
    id: "gemini-carbon",
    label: "Gemini Carbon",
    vendor: "Google",
    description: "Raciocínio avançado com arquivos, áudio e vídeo",
    tier: "deep",
    providerModel: "google/gemini-4-carbon",
    price: { in: 2, out: 10 },
  },
];

/** Qual modelo o Dohko One usa para cada nível. */
export const TIER_DEFAULT: Record<Tier | "build", string> = {
  fast: "claude-haiku",
  balanced: "gpt-terra",
  deep: "claude-sonnet",
  build: "claude-sonnet",
};

export class ModelCatalog {
  private byId = new Map<string, ModelInfo>();

  constructor(public models: ModelInfo[] = DEFAULT_MODELS, public tierDefault = TIER_DEFAULT) {
    for (const m of models) {
      this.byId.set(m.id, m);
      // registra o preço no motor de créditos para estimativas
      MODEL_COST_USD_PER_MTOK[m.id] = { in: m.price.in, out: m.price.out };
    }
    for (const id of Object.values(tierDefault)) {
      if (!this.byId.has(id)) throw new Error(`MODELO_PADRAO_INEXISTENTE: ${id}`);
    }
  }

  get(id: string) {
    return this.byId.get(id);
  }

  public list() {
    return this.models.map(({ providerModel: _p, ...m }) => m);
  }
}
