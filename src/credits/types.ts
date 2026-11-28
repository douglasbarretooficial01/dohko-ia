export type Mode = "chat" | "plan" | "build";

export type GrantKind = "daily_chat" | "daily_build" | "plan" | "topup" | "bonus";

export interface Plan {
  id: string;
  name: string;
  priceBRL: number;
  monthlyCredits: number;
  /** Preço em R$ por crédito avulso; null = plano sem recarga. */
  topupPriceBRL: number | null;
  /** Período de cobrança: priceBRL é cobrado a cada mês ou a cada ano. Os créditos são sempre mensais. */
  interval: "month" | "year";
  /** Créditos do degrau (agrupa mensal e anual na tela). */
  tierCredits: number;
  /** Preço de referência da Lovable no mesmo período (US$), só para conferência interna. */
  referenceUSD?: number;
}

export interface ModelCall {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Custo real informado pelo provedor (US$). Quando presente, substitui a tabela de preços. */
  costUSD?: number;
}

export interface UsageEvent {
  mode: Mode;
  calls: ModelCall[];
  /** Custos externos em US$: busca web, imagem, sandbox… */
  toolCostsUSD?: number;
  /** 0..1 — ação interrompida paga só a fração concluída. */
  completedFraction?: number;
}

export interface CreditBucket {
  id: string;
  workspaceId: string;
  kind: GrantKind;
  balance: number;
  expiresAt: Date;
  createdAt: Date;
}

export type LedgerType = "grant" | "debit" | "hold" | "release" | "expire" | "writeoff";

export interface LedgerEntry {
  id: string;
  workspaceId: string;
  bucketId: string | null;
  type: LedgerType;
  /** Positivo = entra no saldo; negativo = sai. */
  amount: number;
  actionId?: string;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

export interface Hold {
  actionId: string;
  workspaceId: string;
  mode: Mode;
  movements: { bucketId: string; amount: number }[];
  total: number;
  createdAt: Date;
}
