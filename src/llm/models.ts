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
  {
    id: "gemini-flash",
    label: "Gemini Flash",
    vendor: "Google",
    description: "Rápido e barato para perguntas do dia a dia",
    tier: "fast",
    providerModel: "google/gemini-2.5-flash",
    price: { in: 0.3, out: 2.5 },
  },
  {
    id: "gpt-mini",
    label: "GPT Mini",
    vendor: "OpenAI",
    description: "Equilíbrio entre qualidade e custo",
    tier: "balanced",
    providerModel: "openai/gpt-5-mini",
    price: { in: 0.25, out: 2 },
  },
  {
    id: "gpt",
    label: "GPT",
    vendor: "OpenAI",
    description: "Raciocínio forte para tarefas complexas",
    tier: "deep",
    providerModel: "openai/gpt-5",
    price: { in: 1.25, out: 10 },
  },
  {
    id: "claude-sonnet",
    label: "Claude Sonnet",
    vendor: "Anthropic",
    description: "Excelente em escrita, análise e código",
    tier: "deep",
    providerModel: "anthropic/claude-sonnet-4.5",
    price: { in: 3, out: 15 },
  },
  {
    id: "gemini-pro",
    label: "Gemini Pro",
    vendor: "Google",
    description: "Contextos longos e documentos grandes",
    tier: "deep",
    providerModel: "google/gemini-2.5-pro",
    price: { in: 1.25, out: 10 },
  },
];

/** Qual modelo o Dohko One usa para cada nível. */
export const TIER_DEFAULT: Record<Tier | "build", string> = {
  fast: "gemini-flash",
  balanced: "gpt-mini",
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
