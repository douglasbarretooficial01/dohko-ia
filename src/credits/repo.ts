import type { CreditBucket, Hold, LedgerEntry } from "./types.js";

/**
 * Persistência. Em produção, implementar com Postgres (ver sql/schema.sql):
 * `withWorkspaceLock` deve abrir uma transação e fazer
 * `SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE` para serializar débitos.
 */
export interface CreditRepo {
  withWorkspaceLock<T>(workspaceId: string, fn: (tx: CreditTx) => Promise<T>): Promise<T>;
}

export interface CreditTx {
  listBuckets(workspaceId: string): Promise<CreditBucket[]>;
  insertBucket(b: CreditBucket): Promise<void>;
  updateBucketBalance(bucketId: string, balance: number): Promise<void>;
  /** Soma delta ao saldo do bucket (usado ao devolver reservas, mesmo de buckets zerados). */
  addToBucket(bucketId: string, delta: number): Promise<void>;
  appendLedger(e: LedgerEntry): Promise<void>;
  getHold(actionId: string): Promise<Hold | null>;
  saveHold(h: Hold): Promise<void>;
  deleteHold(actionId: string): Promise<void>;
  /** Idempotência: true se esta chave já foi processada. */
  seen(key: string): Promise<boolean>;
  markSeen(key: string): Promise<void>;
}

/** Implementação em memória — para testes e protótipo. */
export class InMemoryRepo implements CreditRepo {
  buckets = new Map<string, CreditBucket>();
  ledger: LedgerEntry[] = [];
  holds = new Map<string, Hold>();
  keys = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();

  async withWorkspaceLock<T>(workspaceId: string, fn: (tx: CreditTx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(workspaceId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn(this.tx()));
    this.locks.set(workspaceId, run);
    return run;
  }

  private tx(): CreditTx {
    return {
      listBuckets: async (ws) => [...this.buckets.values()].filter((b) => b.workspaceId === ws).map((b) => ({ ...b })),
      insertBucket: async (b) => void this.buckets.set(b.id, { ...b }),
      updateBucketBalance: async (id, balance) => {
        const b = this.buckets.get(id);
        if (b) b.balance = balance;
      },
      addToBucket: async (id, delta) => {
        const b = this.buckets.get(id);
        if (b) b.balance = Math.round((b.balance + delta) * 100) / 100;
      },
      appendLedger: async (e) => void this.ledger.push(e),
      getHold: async (id) => this.holds.get(id) ?? null,
      saveHold: async (h) => void this.holds.set(h.actionId, h),
      deleteHold: async (id) => void this.holds.delete(id),
      seen: async (k) => this.keys.has(k),
      markSeen: async (k) => void this.keys.add(k),
    };
  }
}
